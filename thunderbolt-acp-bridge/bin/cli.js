#!/usr/bin/env node

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * thunderbolt-acp-bridge CLI entry point.
 *
 * Thin wiring only: parse argv, build the injectable deps (spawn, ws server,
 * line reader, logger), start the bridge, and translate signals into a graceful
 * stop. All testable logic lives in ./src/*.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'

import { parseArgs } from '../src/args.js'
import { usageError, exitCodes } from '../src/errors.js'
import { createLogger } from '../src/log.js'
import { startBridge } from '../src/server.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Read the package version without importing JSON (Node version-portable). */
const readVersion = () => {
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
      'thunderbolt-acp-bridge ready',
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

  /** @type {((reason: string, code: number) => void) | null} */
  let stopFn = null
  const installSignalHandlers = () => {
    const onSignal = () => stopFn?.('signal', exitCodes.interrupted)
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  }
  installSignalHandlers()

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
