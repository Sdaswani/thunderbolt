// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Stand up a cloudflared quick tunnel in front of the local MCP face (MCP only).
// Spawns `cloudflared tunnel --url <localUrl>`, parses the assigned
// *.trycloudflare.com URL from cloudflared's stderr, and fronts the face with a
// caller-minted mandatory bearer. The bearer is printed to STDERR ONLY and never
// embedded in the public URL or any query string — mcp-server.js compares it
// constant-time on every request.

'use strict'

const { spawn: defaultSpawn } = require('node:child_process')
const { randomBytes: defaultRandomBytes } = require('node:crypto')
const { UnavailableError } = require('./errors')

/** Entropy of the minted bearer: 32 bytes => 256 bits. */
const BEARER_BYTES = 32
/** Grace window before SIGKILLing cloudflared on close(). */
const GRACE_MS = 2000
/** Give cloudflared this long to print its public URL before declaring it unavailable. */
const URL_TIMEOUT_MS = 30000
/** Cap the accumulated stderr buffer so a chatty cloudflared can't grow it unbounded. */
const STDERR_BUFFER_CAP = 64 * 1024
/** Matches the quick-tunnel URL cloudflared prints to its stderr. */
const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

/**
 * Mint a high-entropy bearer for fronting the MCP face. 32 bytes => 256 bits,
 * base64url-encoded so it's safe to carry verbatim in an Authorization header.
 *
 * @param {(n: number) => Buffer} [randomBytes] - injectable crypto.randomBytes.
 * @returns {string}
 */
const generateBearer = (randomBytes = defaultRandomBytes) => randomBytes(BEARER_BYTES).toString('base64url')

/**
 * Start a cloudflared quick tunnel in front of `localUrl`, fronted by the
 * caller-supplied mandatory bearer. Resolves once cloudflared prints its public
 * URL; rejects with an UnavailableError if cloudflared is missing (ENOENT) or
 * never prints a URL in time. The bearer is logged to stderr — never put in the
 * URL.
 *
 * @param {Object} opts
 * @param {string} opts.localUrl - the local MCP face URL to tunnel to.
 * @param {string} opts.bearer - the mandatory bearer fronting the face.
 * @param {Object} opts.logger - PII-safe logger.
 * @param {Function} [opts.spawn] - injectable child_process.spawn.
 * @param {number} [opts.urlTimeoutMs] - how long to wait for the public URL.
 * @returns {Promise<{ publicUrl: string, bearer: string, close(): Promise<void> }>}
 */
const startTunnel = ({ localUrl, bearer, logger, spawn = defaultSpawn, urlTimeoutMs = URL_TIMEOUT_MS }) => {
  return new Promise((resolve, reject) => {
    const settled = { done: false }
    const child = spawn('cloudflared', ['tunnel', '--url', localUrl])

    let graceTimer = null
    const clearGrace = () => {
      if (graceTimer) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
    }

    const close = () =>
      new Promise((resolveClose) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          clearGrace()
          resolveClose()
          return
        }
        child.once('exit', () => {
          clearGrace()
          resolveClose()
        })
        child.kill('SIGTERM')
        graceTimer = setTimeout(() => child.kill('SIGKILL'), GRACE_MS)
        if (typeof graceTimer.unref === 'function') graceTimer.unref()
      })

    const urlTimer = setTimeout(() => {
      if (settled.done) return
      settled.done = true
      child.kill('SIGKILL') // never-orphan
      reject(new UnavailableError({ message: 'cloudflared did not report a tunnel URL in time' }))
    }, urlTimeoutMs)
    if (typeof urlTimer.unref === 'function') urlTimer.unref()

    child.on('error', (err) => {
      if (settled.done) return
      settled.done = true
      clearTimeout(urlTimer)
      // ENOENT => cloudflared not installed; surface as unavailable (cli -> 69).
      reject(new UnavailableError({ code: err.code, message: 'cloudflared not found' }))
    })

    // cloudflared prints diagnostics — including the assigned URL — to stderr.
    // Accumulate across chunks so a URL split over two `data` events still
    // matches; cap the buffer so a chatty cloudflared can't grow it unbounded.
    let stderrBuffer = ''
    child.stderr.on('data', (chunk) => {
      if (settled.done) return
      stderrBuffer = (stderrBuffer + chunk.toString('utf8')).slice(-STDERR_BUFFER_CAP)
      const match = TRYCLOUDFLARE_RE.exec(stderrBuffer)
      if (!match) return
      settled.done = true
      clearTimeout(urlTimer)
      const publicUrl = match[0]
      // Bearer to STDERR ONLY — never in the URL or a query param. The bearer is
      // a secret, so it rides in the event string (printed verbatim) rather than
      // a scalar field (which the allowlist would drop anyway).
      logger.banner(publicUrl)
      logger.warn(`tunnel-bearer Authorization: Bearer ${bearer}`)
      resolve({ publicUrl, bearer, close })
    })
  })
}

module.exports = { startTunnel, generateBearer, BEARER_BYTES, URL_TIMEOUT_MS }
