/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const { UsageError } = require('./errors')
const { resolvePort } = require('./util')

/** @typedef {{ mode: 'acp'|'mcp', host: string, port: number, allowOrigins: string[], allowAnyOrigin: boolean, tunnel: boolean, json: boolean, verbose: boolean, launch: string[] }} ParsedArgs */

const VALID_MODES = new Set(['acp', 'mcp'])

/**
 * True for a token that looks like a flag, so a flag expecting a value never
 * silently swallows the next flag as its value.
 * @param {string|undefined} token
 */
const looksLikeFlag = (token) => token !== undefined && token.startsWith('-')

/**
 * Pure flag parser for the `bridge` subcommand. Splits flags from the child
 * launch argv at the first bare `--`, validates flag values and cross-flag
 * rules, and returns a fully resolved options object — or a
 * `{help:'bridge'}`/`{version}` intent. Throws UsageError on any invalid input
 * so the CLI maps it to exit 64.
 * @param {string[]} argv
 * @returns {ParsedArgs | { help: 'bridge' } | { version: true }}
 */
const parseBridgeArgs = (argv) => {
  if (argv.includes('--help') || argv.includes('-h')) return { help: 'bridge' }
  if (argv.includes('--version') || argv.includes('-V')) return { version: true }

  const delimiterIndex = argv.indexOf('--')
  const flagArgs = delimiterIndex === -1 ? argv : argv.slice(0, delimiterIndex)
  const launch = delimiterIndex === -1 ? [] : argv.slice(delimiterIndex + 1)

  /** @type {Partial<ParsedArgs>} */
  const opts = {
    host: '127.0.0.1',
    port: 0,
    allowOrigins: [],
    allowAnyOrigin: false,
    tunnel: false,
    json: false,
    verbose: false,
  }

  const takeValue = (flag, i) => {
    const value = flagArgs[i + 1]
    if (value === undefined || looksLikeFlag(value)) throw new UsageError(`${flag} requires a value`)
    return value
  }

  let i = 0
  while (i < flagArgs.length) {
    const flag = flagArgs[i]
    if (flag === '--mode') {
      opts.mode = /** @type {'acp'|'mcp'} */ (takeValue(flag, i))
      i += 2
    } else if (flag === '--host') {
      opts.host = takeValue(flag, i)
      i += 2
    } else if (flag === '--port') {
      opts.port = resolvePort(takeValue(flag, i))
      i += 2
    } else if (flag === '--allow-origin') {
      opts.allowOrigins.push(takeValue(flag, i))
      i += 2
    } else if (flag === '--allow-any-origin') {
      opts.allowAnyOrigin = true
      i += 1
    } else if (flag === '--tunnel') {
      opts.tunnel = true
      i += 1
    } else if (flag === '--json') {
      opts.json = true
      i += 1
    } else if (flag === '--verbose') {
      opts.verbose = true
      i += 1
    } else {
      throw new UsageError(`unknown flag ${flag}`)
    }
  }

  if (!opts.mode) throw new UsageError('--mode is required')
  if (!VALID_MODES.has(opts.mode)) throw new UsageError(`--mode must be "acp" or "mcp", got "${opts.mode}"`)
  if (opts.tunnel && opts.mode !== 'mcp') throw new UsageError('--tunnel requires --mode mcp')
  if (launch.length === 0) throw new UsageError('missing child launch argv after "--"')

  return /** @type {ParsedArgs} */ ({ ...opts, launch })
}

/**
 * Top-level subcommand dispatcher. Routes the first token to a subcommand
 * (currently only `bridge`), or short-circuits to a root help/version intent.
 * Resolved bridge opts carry `command: 'bridge'`. Throws UsageError (→ exit 64)
 * on an unknown command.
 * @param {string[]} argv
 * @returns {(ParsedArgs & { command: 'bridge' }) | { help: 'root' } | { help: 'bridge' } | { version: true }}
 */
const parseArgs = (argv) => {
  const [token, ...rest] = argv
  if (token === undefined || token === '--help' || token === '-h') return { help: 'root' }
  if (token === '--version' || token === '-V') return { version: true }
  if (token === 'bridge') {
    const parsed = parseBridgeArgs(rest)
    if ('help' in parsed || 'version' in parsed) return parsed
    return { ...parsed, command: 'bridge' }
  }
  throw new UsageError(`unknown command: ${token}`)
}

module.exports = { parseArgs, parseBridgeArgs }
