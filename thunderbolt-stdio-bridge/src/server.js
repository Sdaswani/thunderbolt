/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ACP WebSocket face for thunderbolt-stdio-bridge: stand up a localhost WebSocket
 * server and relay it to the shared stdio child through the pure relay.
 *
 * The child lifecycle (spawn, line reader, spawn/exit handling, grace window,
 * never-orphan SIGKILL, signal stop with escalation) lives in the shared
 * supervisor (./child.js). This module owns ONLY the ws-specific concerns:
 *   - WebSocketServer with Origin allowlist (verifyClient + defense-in-depth);
 *   - newest-wins single active socket (a new connection supersedes the old);
 *   - backpressure: pause the agent→ws relay while no client is connected so an
 *     in-flight response is held by OS pipe backpressure instead of dropped;
 *   - closeWebSocket as the supervisor's closeFace seam.
 *
 * Dependencies (spawn, WebSocketServer, readline factory, exit) are injected so
 * the face can be exercised with fakes.
 */

import { serverError } from './errors.js'
import { superviseChild } from './child.js'
import { wireAgentToWs, handleWsMessage } from './relay.js'
import { extractLogEvent, sanitizeOrigin, isOriginAllowed, defaultAllowedOrigins } from './log.js'
import { resolvePort, formatHostForUrl, emitInsecureFlagWarnings } from './util.js'

const WS_OPEN = 1
const WS_CLOSE_NORMAL = 1000
const WS_CLOSE_GOING_AWAY = 1011
const WS_CLOSE_POLICY_VIOLATION = 1008

/**
 * Start the bridge. Resolves once the ready banner has been emitted (server
 * listening + child survived grace). Rejects on a fatal startup error after
 * printing an actionable message and setting the exit code.
 *
 * @param {object} cfg
 * @param {string[]} cfg.agentCmd - [command, ...args]
 * @param {string} cfg.host
 * @param {number} cfg.port - 0 = ephemeral
 * @param {string[]} [cfg.allowOrigins] - extra Origins to accept (beyond the Thunderbolt defaults)
 * @param {boolean} [cfg.allowAnyOrigin] - disable the Origin check entirely (loud escape hatch)
 * @param {ReturnType<import('./log.js').createLogger>} cfg.logger
 * @param {object} deps
 * @param {typeof import('node:child_process').spawn} deps.spawn
 * @param {new (opts: object) => import('ws').WebSocketServer} deps.WebSocketServer
 * @param {(stream: NodeJS.ReadableStream) => import('node:events').EventEmitter} deps.createLineReader
 * @param {(label: string) => void} [deps.onBanner] - prints the ready banner
 * @param {(stop: (reason: string, code: number) => void) => void} [deps.onStop] - receives the stop fn synchronously (before grace resolves)
 * @param {(code: number) => void} [deps.exit] - process.exit (injectable)
 * @returns {Promise<{ stop: (reason: string, code: number) => void }>}
 */
export const startBridge = async (cfg, deps) => {
  const { agentCmd, host, port, logger, allowOrigins = [], allowAnyOrigin = false } = cfg
  const { spawn, WebSocketServer, createLineReader, onBanner, onStop, exit = process.exit } = deps

  const allowlist = [...defaultAllowedOrigins, ...allowOrigins]

  emitInsecureFlagWarnings({ host, allowAnyOrigin, logger })

  return new Promise((resolve, reject) => {
    /** @type {import('ws').WebSocketServer | null} */
    let wss = null
    /** @type {import('ws').WebSocket | null} */
    let activeSocket = null
    let readerPaused = false

    const closeWebSocket = (code) => {
      if (activeSocket && activeSocket.readyState === WS_OPEN) activeSocket.close(code)
      wss?.close()
    }

    // The shared supervisor owns the child; the ws face plugs in via these seams.
    const { child, lines, stop, safeExit } = superviseChild(
      { agentCmd, logger },
      {
        spawn,
        createLineReader,
        onReady: () => {
          const resolvedPort = resolvePort(wss, port)
          onBanner?.(`ws://${formatHostForUrl(host)}:${resolvedPort}`)
          resolve({ stop })
        },
        closeFace: (reason) => closeWebSocket(reason === 'going-away' ? WS_CLOSE_GOING_AWAY : WS_CLOSE_NORMAL),
        onFatalRejection: (err) => reject(err),
        exit,
      },
    )

    // While no client is connected, pause the agent→ws relay so the agent's output
    // (e.g. an in-flight response during a client reconnect) is held by OS pipe
    // backpressure instead of dropped. Resumed on the next connection.
    const clearActiveSocket = (socket) => {
      if (activeSocket !== socket) return
      activeSocket = null
      if (!readerPaused) {
        lines.pause()
        readerPaused = true
      }
    }

    // --- agent stdout → ws (single persistent reader, reused across reconnects) ---
    wireAgentToWs({
      lines,
      send: (line) => {
        if (activeSocket && activeSocket.readyState === WS_OPEN) activeSocket.send(line)
      },
      onForward: (line) => logger.debug(extractLogEvent({ direction: 'agent->ws', line })),
      // A dropped line is a raw, non-JSON stdout line that may contain content.
      // Extract ONLY its byte length here — the line text is never logged.
      onDrop: (line) => logger.warn({ lifecycle: 'dropped-non-json', byteSize: Buffer.byteLength(line) }),
    })

    // No client is connected until Thunderbolt dials in, so start the reader PAUSED:
    // early agent stdout is held by OS pipe backpressure instead of read-and-dropped.
    // The first connection resumes it (and any later disconnect re-pauses) — so the
    // held-not-dropped invariant holds for EVERY no-client window, including the first.
    lines.pause()
    readerPaused = true

    // --- WebSocket server -----------------------------------------------------
    // verifyClient runs DURING the upgrade handshake: a disallowed Origin is
    // rejected with HTTP 403 and the WebSocket is never established, so a hostile
    // web page can't even briefly connect. The 'connection' handler below repeats
    // the check as deterministic defense-in-depth (closing with 1008) for any
    // path that bypasses verifyClient.
    const verifyClient = ({ origin }) => allowAnyOrigin || isOriginAllowed(origin, allowlist)
    wss = new WebSocketServer({ host, port, verifyClient })

    wss.on('error', (err) => {
      const { message, exitCode } = serverError(err, { host, port })
      logger.error({ lifecycle: 'server-error', errorCode: err.code })
      process.stderr.write(`\n${message}\n`)
      reject(Object.assign(new Error(message), { exitCode }))
      safeExit(exitCode)
    })

    wss.on('connection', (socket, request) => {
      const rawOrigin = request?.headers?.origin
      const origin = sanitizeOrigin(rawOrigin)

      // Browser WebSocket connections aren't same-origin-protected: reject any
      // Origin that isn't a known Thunderbolt app origin so a random web page on
      // this machine can't hijack the local agent. The origin string is PII-safe
      // to log (sanitized to scheme + host).
      if (!allowAnyOrigin && !isOriginAllowed(rawOrigin, allowlist)) {
        logger.warn({ lifecycle: 'origin-rejected', origin })
        socket.close(WS_CLOSE_POLICY_VIOLATION)
        return
      }

      logger.info({ lifecycle: 'connected', origin })
      // Single-client bridge: a new connection supersedes any previous one. Assign
      // the new socket first (so the old socket's 'close' handler won't null it),
      // then close the old one so a superseded client can't keep injecting into the
      // shared agent stdin while only the newest receives output.
      const previous = activeSocket
      activeSocket = socket
      if (previous && previous !== socket && previous.readyState === WS_OPEN) previous.close(1000)
      if (readerPaused) {
        lines.resume()
        readerPaused = false
      }

      socket.on('message', (data) => {
        // Drop messages from a socket that's been superseded by a newer connection:
        // close() doesn't synchronously stop buffered 'message' events, so guard on
        // identity to keep a stale client out of the shared agent stdin.
        if (activeSocket !== socket) return
        handleWsMessage({
          data,
          write: (chunk) => child.stdin.write(chunk),
          onWrite: (chunk) => logger.debug(extractLogEvent({ direction: 'ws->agent', line: chunk.replace(/\n$/, '') })),
        })
      })
      socket.on('error', (err) => {
        logger.warn({ lifecycle: 'socket-error', errorCode: err.code })
        clearActiveSocket(socket)
      })
      socket.on('close', (closeCode) => {
        clearActiveSocket(socket)
        logger.info({ lifecycle: 'disconnected', closeCode })
      })
    })

    wss.on('listening', () => {
      const resolvedPort = resolvePort(wss, port)
      logger.info({ lifecycle: 'listening', port: resolvedPort })
    })

    deps.onStop?.(stop)
  })
}
