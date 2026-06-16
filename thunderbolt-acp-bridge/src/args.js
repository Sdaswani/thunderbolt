/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Pure CLI argument parser for thunderbolt-acp-bridge.
 *
 * Everything BEFORE the `--` separator is a bridge flag. Everything AFTER it is
 * the agent command + argv, passed verbatim to `spawn` (no shell, no quoting).
 * A standalone `--` is mandatory to separate bridge flags from the agent argv.
 */

const HELP_TEXT = `thunderbolt-acp-bridge — relay a local stdio ACP agent to a localhost WebSocket for Thunderbolt.

Usage:
  npx thunderbolt-acp-bridge [options] -- <agent-command> [agent-args...]

Everything after \`--\` is the agent command, passed straight to the OS (no shell).

Options:
  --port <n>            WebSocket port (default: ephemeral, auto-picked)
  --host <addr>         Bind address (default: 127.0.0.1, loopback only)
  --allow-origin <o>    Extra WebSocket Origin to accept (repeatable). The
                        Thunderbolt app origins are allowed by default.
  --allow-any-origin    Accept ANY Origin (disables the cross-origin guard).
                        Escape hatch for dev/self-host only — not recommended.
  --verbose             Per-frame logging (method + size, redacted; never content)
  --json                Emit logs as raw JSON instead of pretty one-liners
  --help                Show this help and exit
  --version             Print the version and exit

Example:
  npx thunderbolt-acp-bridge -- npx -y @zed-industries/claude-code-acp

Paste the printed ws://127.0.0.1:PORT URL into Thunderbolt → Add Custom Agent.`

/**
 * Parse process argv (the slice AFTER node + script path) into a structured
 * config. Pure: no side effects, no process access.
 *
 * @param {string[]} argv - args after `node bin/cli.js`
 * @returns {{
 *   help: boolean,
 *   version: boolean,
 *   verbose: boolean,
 *   json: boolean,
 *   host: string,
 *   port: number,
 *   allowOrigins: string[],
 *   allowAnyOrigin: boolean,
 *   agentCmd: string[],
 *   error: string | null,
 *   helpText: string,
 * }}
 */
export const parseArgs = (argv) => {
  const base = {
    help: false,
    version: false,
    verbose: false,
    json: false,
    host: '127.0.0.1',
    port: 0,
    allowOrigins: [],
    allowAnyOrigin: false,
    agentCmd: [],
    error: null,
    helpText: HELP_TEXT,
  }

  const separatorIndex = argv.indexOf('--')
  const flags = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex)
  const agentCmd = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1)

  const result = { ...base, agentCmd }

  let i = 0
  while (i < flags.length) {
    const flag = flags[i]
    if (flag === '--help' || flag === '-h') {
      return { ...result, help: true }
    }
    if (flag === '--version' || flag === '-v') {
      return { ...result, version: true }
    }
    if (flag === '--verbose') {
      result.verbose = true
      i += 1
      continue
    }
    if (flag === '--json') {
      result.json = true
      i += 1
      continue
    }
    if (flag === '--allow-any-origin') {
      result.allowAnyOrigin = true
      i += 1
      continue
    }
    if (flag === '--allow-origin' || flag.startsWith('--allow-origin=')) {
      const value = flag.includes('=') ? flag.slice('--allow-origin='.length) : flags[i + 1]
      if (!value) return { ...result, error: '--allow-origin requires a value' }
      result.allowOrigins.push(value)
      i += flag.includes('=') ? 1 : 2
      continue
    }
    if (flag === '--host' || flag.startsWith('--host=')) {
      const value = flag.includes('=') ? flag.slice('--host='.length) : flags[i + 1]
      if (!value) return { ...result, error: '--host requires a value' }
      result.host = value
      i += flag.includes('=') ? 1 : 2
      continue
    }
    if (flag === '--port' || flag.startsWith('--port=')) {
      const value = flag.includes('=') ? flag.slice('--port='.length) : flags[i + 1]
      if (!value) return { ...result, error: '--port requires a value' }
      const port = Number(value)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        return { ...result, error: `invalid --port: ${value}` }
      }
      result.port = port
      i += flag.includes('=') ? 1 : 2
      continue
    }
    if (!flag.startsWith('-')) {
      // A bare token before `--` almost always means the user forgot the
      // separator (e.g. `thunderbolt-acp-bridge my-agent` instead of `thunderbolt-acp-bridge -- my-agent`).
      return { ...result, error: 'no agent command given (did you forget the `--` before the agent command?)' }
    }
    return { ...result, error: `unknown option: ${flag}` }
  }

  if (separatorIndex === -1 || agentCmd.length === 0) {
    return { ...result, error: 'no agent command given' }
  }

  return result
}
