#!/usr/bin/env node

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * thunderbolt-stdio-bridge CLI entry point.
 *
 * Thin wiring only: parse argv, build the injectable deps (spawn, ws server,
 * line reader, logger), start the bridge, and translate signals into a graceful
 * stop. All testable logic lives in ./src/*.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { parseArgs } from '../src/args.js'
import { usageError, tunnelError, exitCodes } from '../src/errors.js'
import { createLogger } from '../src/log.js'
import { superviseChild } from '../src/child.js'
import { startBridge } from '../src/server.js'
import { startMcpFace, newSessionId } from '../src/mcp-server.js'
import { startTunnel, generateBearer } from '../src/tunnel.js'
import { formatHostForUrl } from '../src/util.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Wire SIGINT/SIGTERM to the supervisor's graceful stop. `getStop` is read
 * lazily on each signal so the ACP path (whose stop is captured only once the
 * startBridge promise wires it) and the MCP path (stop known synchronously) can
 * share one installation. Signal handling lives in the CLI composition root, not
 * the reusable supervisor.
 * @param {() => ((reason: string, code: number) => void) | null | undefined} getStop
 */
const installSignalHandlers = (getStop) => {
  const onSignal = () => getStop()?.('signal', exitCodes.interrupted)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
}

/**
 * Read the package version. In a normal Node install this reads package.json
 * relative to the script; in the bundled CLI (no surrounding files) the build
 * inlines the version as `__BRIDGE_VERSION__` via esbuild `define`.
 */
const readVersion = () => {
  if (typeof __BRIDGE_VERSION__ === 'string') return __BRIDGE_VERSION__
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  return pkg.version
}

/**
 * Print the prominent, copyable ready banner to stderr (so it never mixes with
 * the agent's stdout/ACP frames).
 * @param {string} wsUrl
 * @param {string} cmd0
 */
const printBanner = (wsUrl, cmd0) => {
  process.stderr.write(
    [
      '',
      'thunderbolt-stdio-bridge ready',
      `  Agent:     ${cmd0}`,
      `  Listening: ${wsUrl}`,
      '',
      `Paste this URL into Thunderbolt → Add Custom Agent:`,
      `  ${wsUrl}`,
      '',
      'Ctrl-C to stop.',
      '',
    ].join('\n'),
  )
}

/**
 * Print the MCP-mode ready banner to stderr (kept off stdout so it never mixes
 * with the agent's MCP frames).
 * @param {string} httpUrl - e.g. http://127.0.0.1:PORT/mcp
 * @param {string} cmd0
 */
const printMcpBanner = (httpUrl, cmd0) => {
  process.stderr.write(
    [
      '',
      'thunderbolt-stdio-bridge ready (MCP)',
      `  Server:    ${cmd0}`,
      `  Listening: ${httpUrl}`,
      '',
      'Paste this URL into Thunderbolt → Add MCP Server:',
      `  ${httpUrl}`,
      '',
      'Ctrl-C to stop.',
      '',
    ].join('\n'),
  )
}

/**
 * Print the cloudflared tunnel banner to stderr. The public MCP URL and the
 * bearer secret are deliberately on their own lines for clean copy/paste; the
 * secret NEVER appears in a URL or query string.
 * @param {{ mcpUrl: string, bearer: string, cmd0: string }} info
 */
const printTunnelBanner = ({ mcpUrl, bearer, cmd0 }) => {
  process.stderr.write(
    [
      '',
      'thunderbolt-stdio-bridge ready (MCP over cloudflared tunnel)',
      `  Server:     ${cmd0}`,
      `  Public URL: ${mcpUrl}`,
      '',
      'In Thunderbolt → Add MCP Server, paste:',
      `  URL:           ${mcpUrl}`,
      `  Authorization: Bearer ${bearer}`,
      '',
      'The bearer is REQUIRED on every request — keep it secret.',
      'Note: server-push/SSE degrades over quick tunnels; request/response tool',
      'calls work normally.',
      '',
      'Ctrl-C to stop.',
      '',
    ].join('\n'),
  )
}

/**
 * Run the MCP Streamable HTTP face: supervise the shared stdio child, drive the
 * SDK transport as a bare adapter, optionally open a cloudflared tunnel, and
 * translate Ctrl-C into the supervisor's graceful stop (which also tears the
 * tunnel + http server down via closeFace).
 * @param {ReturnType<typeof parseArgs>} args
 * @param {ReturnType<typeof createLogger>} logger
 */
const runMcp = async (args, logger) => {
  const cmd0 = args.agentCmd[0]

  // A tunnel makes the MCP face publicly reachable, so it MUST require a bearer.
  const requiredBearer = args.tunnel ? generateBearer() : null

  /** @type {(() => void) | null} */
  let closeHttp = null
  /** @type {(() => void) | null} */
  let stopTunnel = null

  // The ready banner prints once BOTH conditions hold: the child survived the
  // grace window (onReady) AND the face — plus the cloudflared tunnel, which can
  // take longer than the grace window — is up. Either may finish first.
  let graceSurvived = false
  /** @type {(() => void) | null} */
  let printReadyBanner = null
  const maybePrintBanner = () => {
    if (!graceSurvived || printReadyBanner === null) return
    const print = printReadyBanner
    printReadyBanner = null
    print()
  }

  const { child, lines, stop, safeExit } = superviseChild(
    { agentCmd: args.agentCmd, logger },
    {
      spawn,
      createLineReader: (stream) => createInterface({ input: stream }),
      onReady: () => {
        graceSurvived = true
        maybePrintBanner()
      },
      // Shutdown teardown: stop the cloudflared tunnel and close the http server
      // + SDK transport (wired in once the face/tunnel are up).
      closeFace: () => {
        stopTunnel?.()
        closeHttp?.()
      },
      // The supervisor already printed the actionable message and exited; main
      // awaits runMcp only for setup, so there is no start promise to reject.
      onFatalRejection: () => {},
    },
  )

  installSignalHandlers(() => stop)

  const face = await startMcpFace(
    {
      child,
      lines,
      host: args.host,
      port: args.port,
      allowOrigins: args.allowOrigins,
      allowAnyOrigin: args.allowAnyOrigin,
      requiredBearer,
      logger,
    },
    {
      createHttpServer: (handler) => createServer(handler),
      createTransport: () =>
        new StreamableHTTPServerTransport({ sessionIdGenerator: newSessionId, enableJsonResponse: true }),
    },
  ).catch((err) => {
    // A bind failure (e.g. EADDRINUSE) must never orphan the child — reap it.
    const exitCode = typeof err?.exitCode === 'number' ? err.exitCode : exitCodes.unavailable
    process.stderr.write(`\n${err?.message ?? 'MCP server failed to start'}\n`)
    safeExit(exitCode)
    return null
  })
  if (face === null) return
  closeHttp = face.close
  const { port } = face

  if (args.tunnel) {
    // Capture the teardown SYNCHRONOUSLY (onStop fires when cloudflared spawns,
    // before it announces a URL) so a Ctrl-C mid-startup still kills cloudflared.
    const tunnel = await startTunnel(
      { host: args.host, port, logger },
      {
        spawn,
        onStop: (s) => {
          stopTunnel = s
        },
      },
    ).catch((err) => {
      // cloudflared missing / early exit: tear the stdio child down and exit with
      // the actionable code from tunnelError (70 for missing, 69 otherwise).
      const exitCode = typeof err?.exitCode === 'number' ? err.exitCode : tunnelError(err).exitCode
      process.stderr.write(`\n${err?.message ?? 'cloudflared tunnel failed'}\n`)
      safeExit(exitCode)
      return null
    })
    if (tunnel === null) return
    stopTunnel = tunnel.stop
    printReadyBanner = () => printTunnelBanner({ mcpUrl: tunnel.mcpUrl, bearer: requiredBearer, cmd0 })
    maybePrintBanner()
    return
  }

  printReadyBanner = () => printMcpBanner(`http://${formatHostForUrl(args.host)}:${port}/mcp`, cmd0)
  maybePrintBanner()
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    process.stdout.write(`${args.helpText}\n`)
    process.exit(exitCodes.ok)
  }
  if (args.version) {
    process.stdout.write(`${readVersion()}\n`)
    process.exit(exitCodes.ok)
  }
  if (args.error) {
    const { message, exitCode } = usageError(args.error)
    process.stderr.write(`${message}\n\n${args.helpText}\n`)
    process.exit(exitCode)
  }

  const logger = createLogger({ json: args.json, verbose: args.verbose })
  const cmd0 = args.agentCmd[0]

  if (args.mode === 'mcp') {
    await runMcp(args, logger)
    return
  }

  /** @type {((reason: string, code: number) => void) | null} */
  let stopFn = null
  installSignalHandlers(() => stopFn)

  await startBridge(
    {
      agentCmd: args.agentCmd,
      host: args.host,
      port: args.port,
      allowOrigins: args.allowOrigins,
      allowAnyOrigin: args.allowAnyOrigin,
      logger,
    },
    {
      spawn,
      WebSocketServer,
      createLineReader: (stream) => createInterface({ input: stream }),
      onBanner: (wsUrl) => printBanner(wsUrl, cmd0),
      // Capture `stop` immediately (before the grace window resolves) so a
      // Ctrl-C during startup still tears the child + ws down cleanly.
      onStop: (stop) => {
        stopFn = stop
      },
    },
  )
}

main().catch((err) => {
  // startBridge already printed an actionable message + set the exit code.
  const exitCode = typeof err?.exitCode === 'number' ? err.exitCode : exitCodes.unavailable
  process.exit(exitCode)
})
