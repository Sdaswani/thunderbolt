/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Small shared helpers used by both protocol faces (the ACP ws server and the
 * MCP http server). Kept dependency-free and pure.
 */

/**
 * Resolve the actual listening port of a server (an ephemeral `0` request is
 * assigned a real port by the OS). Works for both a `ws` WebSocketServer and a
 * `node:http` Server — both expose `address(): { port } | string | null`.
 * @param {{ address?: () => unknown }} server
 * @param {number} requested
 * @returns {number}
 */
export const resolvePort = (server, requested) => {
  const address = server?.address?.()
  if (
    address &&
    typeof address === 'object' &&
    typeof (/** @type {{ port?: unknown }} */ (address).port) === 'number'
  ) {
    return /** @type {{ port: number }} */ (address).port
  }
  return requested
}

/**
 * Format a bind host for inclusion in a URL. An IPv6 literal (the only host form
 * containing a colon) is wrapped in brackets per RFC 3986, unless the caller
 * already bracketed it (avoid `[[::1]]`).
 * @param {string} host
 * @returns {string}
 */
export const formatHostForUrl = (host) => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host)
