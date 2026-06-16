/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Error → actionable message + exit-code mapping (pure).
 *
 * Exit codes follow sysexits.h conventions:
 *   64 (EX_USAGE)       — bad CLI invocation (no/invalid args)
 *   69 (EX_UNAVAILABLE) — agent/runtime problem (ENOENT, EADDRINUSE, early exit)
 *  130 (128+SIGINT)     — clean Ctrl-C stop
 *    0                  — clean shutdown
 */

export const exitCodes = {
  ok: 0,
  usage: 64,
  unavailable: 69,
  interrupted: 130,
}

/**
 * Map a usage problem (bad/missing args) to a message + exit code.
 * Always pairs with the help text at the call site.
 *
 * @param {string} reason - the parser's error string
 * @returns {{ message: string, exitCode: number }}
 */
export const usageError = (reason) => ({
  message: `thunderbolt-acp-bridge: ${reason}`,
  exitCode: exitCodes.usage,
})

/**
 * Map a Node spawn/server error to an actionable message + exit code.
 * Only allowlisted scalars (code, the command name) reach the message —
 * never argv tail, paths, or env.
 *
 * @param {{ code?: string }} err - the Node error (e.g. ENOENT, EADDRINUSE)
 * @param {{ cmd0?: string, host?: string, port?: number }} [ctx]
 * @returns {{ message: string, exitCode: number }}
 */
export const spawnError = (err, ctx = {}) => {
  const code = err?.code
  if (code === 'ENOENT') {
    const cmd0 = ctx.cmd0 ?? 'the agent command'
    return {
      message: `command not found: ${cmd0} — is it installed and on your PATH?`,
      exitCode: exitCodes.unavailable,
    }
  }
  if (code === 'EACCES') {
    const cmd0 = ctx.cmd0 ?? 'the agent command'
    return {
      message: `permission denied launching: ${cmd0} — is it executable?`,
      exitCode: exitCodes.unavailable,
    }
  }
  return {
    message: `failed to start agent (${code ?? 'unknown error'})`,
    exitCode: exitCodes.unavailable,
  }
}

/**
 * Map a WebSocket-server bind error to a message + exit code.
 *
 * @param {{ code?: string }} err
 * @param {{ host?: string, port?: number }} [ctx]
 * @returns {{ message: string, exitCode: number }}
 */
export const serverError = (err, ctx = {}) => {
  if (err?.code === 'EADDRINUSE') {
    const where = ctx.port ? `${ctx.host ?? '127.0.0.1'}:${ctx.port}` : 'the requested port'
    return {
      message: `port already in use (${where}) — omit --port to auto-pick, or choose another`,
      exitCode: exitCodes.unavailable,
    }
  }
  return {
    message: `WebSocket server error (${err?.code ?? 'unknown error'})`,
    exitCode: exitCodes.unavailable,
  }
}

/**
 * Map an early agent exit (before it spoke ACP) to a message + exit code.
 * The caller appends redacted stderr tail separately.
 *
 * @param {{ code?: number | null, signal?: string | null, cmd0?: string }} info
 * @returns {{ message: string, exitCode: number }}
 */
export const earlyExitError = (info) => {
  const cmd0 = info.cmd0 ?? 'the agent'
  const how =
    info.signal != null
      ? `signal ${info.signal}`
      : `code ${info.code ?? 'unknown'}`
  return {
    message: `agent exited (${how}) before speaking ACP — try running ${cmd0} directly to see why`,
    exitCode: exitCodes.unavailable,
  }
}
