/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shared stdio-child supervisor for thunderbolt-stdio-bridge.
 *
 * Both protocol faces — the ACP WebSocket relay (server.js) and the MCP
 * Streamable HTTP face (mcp-server.js) — wrap the SAME single persistent stdio
 * child. This module owns every concern that is about the CHILD rather than the
 * protocol:
 *   - spawn ['pipe','pipe','inherit'] (the agent's stderr passes through, PII-safe);
 *   - an ndjson line reader over stdout;
 *   - stdin/stdout 'error' handlers (log the errorCode only — never content);
 *   - child 'error' → spawnError; child 'exit' → earlyExit (before ready) vs
 *     agent-exited (after ready);
 *   - a grace window the child must survive before the face declares readiness;
 *   - never-orphan SIGKILL on a fatal error (safeExit);
 *   - signal-driven stop() with SIGTERM → SIGKILL escalation and a single,
 *     deferred final exit.
 *
 * The face supplies only the protocol-specific seams: onReady (emit the banner +
 * resolve its start promise), closeFace (tear down ws sockets/server or the http
 * server + SDK transport), and onFatalRejection (reject its start promise).
 *
 * Dependencies (spawn, line-reader factory, exit) are injected so the whole
 * lifecycle is exercisable with fakes — no real processes in unit tests.
 */

import { exitCodes, spawnError, earlyExitError } from './errors.js'

const GRACE_MS = 750
const KILL_ESCALATION_MS = 2000

/** Protocol-agnostic close reason handed to the face's closeFace seam. Each face
 *  maps it to its own teardown (the ws face → a close code; the MCP face closes
 *  the http server + SDK transport and ignores the reason). */
const FACE_CLOSE_NORMAL = 'normal'
const FACE_CLOSE_GOING_AWAY = 'going-away'

/**
 * Spawn and supervise the persistent stdio child shared by both faces.
 *
 * @param {object} cfg
 * @param {string[]} cfg.agentCmd - [command, ...args]
 * @param {ReturnType<import('./log.js').createLogger>} cfg.logger
 * @param {number} [cfg.graceMs] - window the child must survive before onReady (default 750)
 * @param {number} [cfg.killEscalationMs] - SIGTERM→SIGKILL window on stop (default 2000)
 * @param {object} deps
 * @param {typeof import('node:child_process').spawn} deps.spawn
 * @param {(stream: NodeJS.ReadableStream) => import('node:events').EventEmitter} deps.createLineReader
 * @param {() => void} deps.onReady - fired ONCE after the child survives grace (face: banner + resolve)
 * @param {(reason: 'normal' | 'going-away') => void} deps.closeFace - face teardown (ws maps reason→close code; http closes server + transport)
 * @param {(err: Error & { exitCode: number }) => void} deps.onFatalRejection - reject the face's start promise
 * @param {(code: number) => void} [deps.exit] - process.exit (injectable)
 * @returns {{
 *   child: import('node:child_process').ChildProcess,
 *   lines: import('node:events').EventEmitter,
 *   stop: (reason: string, code: number) => void,
 *   safeExit: (code: number) => void,
 * }}
 */
export const superviseChild = (cfg, deps) => {
  const { agentCmd, logger, graceMs = GRACE_MS, killEscalationMs = KILL_ESCALATION_MS } = cfg
  const { spawn, createLineReader, onReady, closeFace, onFatalRejection, exit = process.exit } = deps

  const cmd0 = agentCmd[0]
  const child = spawn(cmd0, agentCmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createLineReader(child.stdout)

  let ready = false
  let exited = false
  let shuttingDown = false
  // The exit code a signal-driven stop should ultimately exit with. The child's
  // 'exit' handler reads it so the actual exit happens only once the child dies.
  let stopCode = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let killTimer = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let graceTimer = null

  // One-shot final exit. After a signal-driven stop the actual exit is deferred
  // to the child's 'exit' event (or the SIGKILL fallback timer), so guard it.
  const finalExit = (code) => {
    if (exited) return
    exited = true
    if (graceTimer) clearTimeout(graceTimer)
    exit(code)
  }

  // Never orphan the agent: if the child outlived a fatal error (e.g. the face's
  // server failed to bind), SIGKILL it before exiting. safeExit is the fatal
  // chokepoint; the signal path uses stop(), so this never double-kills.
  const safeExit = (code) => {
    if (shuttingDown) return
    shuttingDown = true
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    finalExit(code)
  }

  /**
   * Stop the bridge on a signal: close the face, SIGTERM the child, and DEFER the
   * final exit — let the child's 'exit' handler drive it once the agent dies. A
   * REF'd fallback timer escalates to SIGKILL (and forces exit) if a stubborn
   * agent ignores SIGTERM, so it can never be orphaned.
   * @param {string} reason
   * @param {number} code
   */
  const stop = (reason, code) => {
    if (shuttingDown) return
    shuttingDown = true
    stopCode = code
    logger.info({ lifecycle: 'stopping', reason })
    closeFace(FACE_CLOSE_NORMAL)
    process.stderr.write('\nStopping…\n')

    // Already dead? Exit straight away.
    if (child.exitCode !== null || child.signalCode !== null) {
      finalExit(code)
      return
    }

    child.kill('SIGTERM')
    killTimer = setTimeout(() => {
      logger.warn({ lifecycle: 'kill-escalation' })
      child.kill('SIGKILL')
      finalExit(code)
    }, killEscalationMs)
  }

  child.stdin.on('error', (err) => {
    // EPIPE when the agent closed stdin — log lifecycle, don't crash.
    logger.warn({ lifecycle: 'stdin-error', errorCode: err.code })
  })

  child.stdout.on('error', (err) => {
    // An unhandled stdout 'error' would crash Node — log the code only (PII-safe).
    logger.warn({ lifecycle: 'stdout-error', errorCode: err.code })
  })

  child.on('error', (err) => {
    const { message, exitCode } = spawnError(err, { cmd0 })
    logger.error({ lifecycle: 'spawn-failed', errorCode: err.code })
    process.stderr.write(`\n${message}\n`)
    closeFace(FACE_CLOSE_GOING_AWAY)
    onFatalRejection(Object.assign(new Error(message), { exitCode }))
    safeExit(exitCode)
  })

  // Registered synchronously in the same tick as spawn() above (nothing awaits
  // before this) and a child 'exit' is always delivered asynchronously, so this
  // listener can never miss it. That invariant is what makes the grace timer's
  // `exitCode !== null` early-return safe — by the time exitCode is set, this
  // handler has already settled the face's promise. Do NOT introduce an `await`
  // before this registration: it would open a window where the child exits
  // unobserved.
  child.on('exit', (code, signal) => {
    // A signal-driven stop is in progress: the child has now died, so clear the
    // SIGKILL fallback and drive the deferred final exit.
    if (shuttingDown) {
      if (killTimer) clearTimeout(killTimer)
      logger.info({ lifecycle: 'agent-exited', exitCode: code ?? undefined, signal: signal ?? undefined })
      process.stderr.write('\nStopped.\n')
      finalExit(stopCode ?? exitCodes.ok)
      return
    }
    if (!ready) {
      const { message, exitCode } = earlyExitError({ code, signal, cmd0 })
      logger.error({ lifecycle: 'agent-early-exit', exitCode: code ?? undefined, signal: signal ?? undefined })
      process.stderr.write(`\n${message}\n`)
      process.stderr.write("(the agent's own output above may say why)\n")
      closeFace(FACE_CLOSE_GOING_AWAY)
      onFatalRejection(Object.assign(new Error(message), { exitCode }))
      safeExit(exitCode)
      return
    }
    logger.info({ lifecycle: 'agent-exited', exitCode: code ?? undefined, signal: signal ?? undefined })
    process.stderr.write('\nAgent exited. Stopping bridge.\n')
    closeFace(FACE_CLOSE_GOING_AWAY)
    safeExit(code === 0 ? exitCodes.ok : exitCodes.unavailable)
  })

  // Grace window: the child must survive graceMs (and the face must not already
  // be tearing down) before we declare readiness. A child that dies inside the
  // window takes the early-exit path above instead.
  graceTimer = setTimeout(() => {
    if (shuttingDown) return
    if (child.exitCode !== null || child.signalCode !== null) return // exit handler already fired
    ready = true
    onReady()
  }, graceMs)

  return { child, lines, stop, safeExit }
}
