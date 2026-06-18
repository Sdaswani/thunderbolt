/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Optional cloudflared quick-tunnel for the MCP face (MCP-only; ACP is rejected
 * upstream in args.js because it carries no client auth).
 *
 * A quick tunnel exposes the loopback MCP server at a public
 * `https://<rand>.trycloudflare.com` URL. To keep that public surface from being
 * an open agent, the MCP face REQUIRES a bearer secret (generated here) on every
 * request — the secret is printed to STDERR only, never embedded in the URL.
 *
 * `spawn` is injected so the whole module is exercisable with a fake cloudflared
 * (no network, no binary) in unit tests.
 */

import { randomBytes } from 'node:crypto'

import { tunnelError } from './errors.js'
import { formatHostForUrl } from './util.js'

/** cloudflared prints the quick-tunnel URL once, e.g.
 *  `https://random-words-1234.trycloudflare.com`. Match it on either stream. */
const TRYCLOUDFLARE_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

/**
 * Generate a strong URL-safe bearer secret for the tunneled MCP face.
 * 32 random bytes → base64url (~43 chars), ample entropy and copy-pasteable.
 * @returns {string}
 */
export const generateBearer = () => randomBytes(32).toString('base64url')

/**
 * Extract the first `*.trycloudflare.com` URL from a chunk of cloudflared output.
 * @param {string} text
 * @returns {string | null} the public origin (no path), or null if not present
 */
export const parseTrycloudflareUrl = (text) => {
  const match = TRYCLOUDFLARE_URL.exec(text)
  return match ? match[0] : null
}

/**
 * Spawn `cloudflared tunnel --url http://HOST:PORT` and resolve once it prints
 * the public `*.trycloudflare.com` URL. Rejects (with an actionable
 * {@link tunnelError}) if cloudflared is missing from PATH or exits before
 * announcing a URL.
 *
 * The returned `stop()` hard-kills the cloudflared child (SIGKILL — a quick tunnel
 * is stateless, so there is nothing to flush) — the CLI calls it alongside the
 * stdio-child teardown, and `onStop` hands it back synchronously for mid-startup.
 *
 * @param {object} cfg
 * @param {string} cfg.host - loopback host the MCP face is bound to
 * @param {number} cfg.port - the resolved local MCP port
 * @param {ReturnType<import('./log.js').createLogger>} cfg.logger
 * @param {object} deps
 * @param {import('node:child_process').spawn} deps.spawn
 * @param {(stop: () => void) => void} [deps.onStop] - receives the teardown fn SYNCHRONOUSLY (before the URL is announced)
 * @returns {Promise<{ publicUrl: string, mcpUrl: string, stop: () => void }>}
 */
export const startTunnel = ({ host, port, logger }, { spawn, onStop }) =>
  new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['tunnel', '--url', `http://${formatHostForUrl(host)}:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // A quick tunnel is a stateless, ephemeral reverse proxy — nothing to flush on
    // shutdown — so tear it down with a hard SIGKILL. That GUARANTEES no orphaned
    // cloudflared even though the parent process.exits the moment the stdio child
    // dies (a SIGTERM + deferred grace would race that exit and could leak).
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    // Hand the teardown back SYNCHRONOUSLY (before the URL is announced) so a
    // Ctrl-C during tunnel startup still tears cloudflared down — otherwise the
    // caller has no handle until this Promise resolves and could orphan it.
    onStop?.(stop)

    let settled = false

    const onUrlText = (chunk) => {
      if (settled) return
      const publicUrl = parseTrycloudflareUrl(String(chunk))
      if (publicUrl === null) return
      settled = true
      logger.info({ lifecycle: 'tunnel-up', host: hostOf(publicUrl) })
      resolve({ publicUrl, mcpUrl: `${publicUrl}/mcp`, stop })
    }

    // cloudflared prints the URL to stderr; scan stdout too for forward-compat.
    child.stdout?.on('data', onUrlText)
    child.stderr?.on('data', onUrlText)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      const { message, exitCode } = tunnelError(err)
      logger.error({ lifecycle: 'tunnel-spawn-failed', errorCode: err?.code })
      reject(Object.assign(new Error(message), { exitCode }))
    })

    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      const reason = signal != null ? `signal ${signal}` : `code ${code ?? 'unknown'}`
      const { message, exitCode } = tunnelError({ reason: `exited before announcing a URL (${reason})` })
      logger.error({ lifecycle: 'tunnel-exited-early', reason })
      reject(Object.assign(new Error(message), { exitCode }))
    })
  })

/** Log-safe host of a URL (never the full URL, which is the public secret-ish). */
const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return 'unknown'
  }
}
