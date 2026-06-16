/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * True when `host` refers to the loopback interface — `localhost`, any
 * `*.localhost` subdomain, the IPv4 loopback block `127.0.0.0/8`, or the IPv6
 * loopback `::1`. Mirrors the backend's loopback test in
 * `backend/src/utils/url-validation.ts` (kept in sync by hand — both sides care
 * about the same set), but stays dependency-free so it doesn't pull `ipaddr.js`
 * into the frontend bundle.
 *
 * Used to carve loopback ACP targets out of the cloud-proxy path: a browser
 * connecting to its own machine has no SSRF surface (the proxy's localhost
 * rejection protects the *cloud backend*, which is irrelevant here), so we let
 * it connect directly with a native `WebSocket`.
 *
 * Accepts a bare hostname; bracketed IPv6 (`[::1]`) is unwrapped so callers can
 * pass either `URL.hostname` (already unbracketed) or a raw host token.
 */
export const isLoopbackHost = (host: string): boolean => {
  const unwrapped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const h = unwrapped.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) {
    return true
  }
  if (h === '::1') {
    return true
  }
  // IPv4 loopback block 127.0.0.0/8 — any address whose first octet is 127.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/**
 * True when `url` is a parseable WebSocket/HTTP URL whose host is loopback (see
 * `isLoopbackHost`). Unparseable input is treated as non-loopback. The browser's
 * URL parser canonicalizes IPv4 shorthand/octal/hex (e.g. `0x7f.0.0.1`,
 * `127.1`, `2130706433`) to `127.0.0.1` before the host check.
 */
export const isLoopbackUrl = (url: string): boolean => {
  try {
    return isLoopbackHost(new URL(url).hostname)
  } catch {
    return false
  }
}
