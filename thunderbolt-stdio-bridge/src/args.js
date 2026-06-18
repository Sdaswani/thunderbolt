/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Pure CLI argument parser for thunderbolt-stdio-bridge.
 *
 * Everything BEFORE the `--` separator is a bridge flag. Everything AFTER it is
 * the agent command + argv, passed verbatim to `spawn` (no shell, no quoting).
 * A standalone `--` is mandatory to separate bridge flags from the agent argv.
 */

const HELP_TEXT = `thunderbolt-stdio-bridge — bridge a local stdio agent or MCP server to Thunderbolt over localhost.

In ACP mode it relays a stdio ACP agent over a WebSocket; in MCP mode it serves a
local stdio MCP server over Streamable HTTP at /mcp.

Usage:
  npx thunderbolt-stdio-bridge --mode <acp|mcp> [options] -- <command> [args...]

Everything after \`--\` is the agent/server command, passed straight to the OS (no shell).

Options:
  --mode <acp|mcp>     REQUIRED. Protocol face: acp = WebSocket relay for an ACP
                       agent, mcp = MCP Streamable HTTP server at /mcp
  --tunnel             (mcp only) Expose the MCP face over a public cloudflared
                       tunnel with a mandatory auto-generated bearer secret.
                       Rejected with --mode acp (ACP has no client auth).
  --port <n>            WebSocket/HTTP port (default: ephemeral, auto-picked)
  --host <addr>         Bind address (default: 127.0.0.1, loopback only)
  --allow-origin <o>    Extra Origin to accept (repeatable). The Thunderbolt app
                        origins are allowed by default.
  --allow-any-origin    Accept ANY Origin (disables the cross-origin guard).
                        Escape hatch for dev/self-host only — not recommended.
  --verbose             Per-frame logging (method + size, redacted; never content)
  --json                Emit logs as raw JSON instead of pretty one-liners
  --help                Show this help and exit
  --version             Print the version and exit

Examples:
  npx thunderbolt-stdio-bridge --mode acp -- npx -y @zed-industries/claude-code-acp
  npx thunderbolt-stdio-bridge --mode mcp -- npx -y @modelcontextprotocol/server-everything

Paste the printed URL into Thunderbolt — the ws://127.0.0.1:PORT URL goes under
Add Custom Agent (acp); the http://127.0.0.1:PORT/mcp URL goes under Add MCP Server (mcp).`

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
 *   mode: 'acp' | 'mcp' | null,
 *   tunnel: boolean,
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
    mode: null,
    tunnel: false,
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
    if (flag === '--tunnel') {
      result.tunnel = true
      i += 1
      continue
    }
    if (flag === '--mode' || flag.startsWith('--mode=')) {
      const value = flag.includes('=') ? flag.slice('--mode='.length) : flags[i + 1]
      if (!value) return { ...result, error: '--mode requires a value (acp or mcp)' }
      if (value !== 'acp' && value !== 'mcp')
        return { ...result, error: `invalid --mode: ${value} (expected acp or mcp)` }
      result.mode = value
      i += flag.includes('=') ? 1 : 2
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
      // separator (e.g. `thunderbolt-stdio-bridge my-agent` instead of `thunderbolt-stdio-bridge -- my-agent`).
      return { ...result, error: 'no agent command given (did you forget the `--` before the agent command?)' }
    }
    return { ...result, error: `unknown option: ${flag}` }
  }

  if (separatorIndex === -1 || agentCmd.length === 0) {
    return { ...result, error: 'no agent command given' }
  }

  // --mode is part of the interface, not a silent default: a stdio child is
  // either an ACP agent (ws relay) or an MCP server (http face), and guessing
  // wrong would relay the wrong protocol. Require the caller to say which.
  if (result.mode === null) {
    return { ...result, error: '--mode is required (acp or mcp)' }
  }

  // A public cloudflared tunnel over ACP would be an unauthenticated
  // remote-code primitive: ACP carries no client auth, so anyone who learns the
  // tunnel URL could drive the agent. MCP gates the tunnel behind a mandatory
  // bearer; ACP has no such gate and stays localhost-only.
  if (result.tunnel && result.mode === 'acp') {
    return { ...result, error: '--tunnel is not allowed with --mode acp (ACP has no client auth; a public tunnel would expose an unauthenticated agent — ACP is localhost-only). Use --mode mcp to tunnel.' }
  }

  return result
}
