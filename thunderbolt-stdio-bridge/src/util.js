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

/**
 * Whether a bind host is loopback-only (reachable just from this machine) — the
 * narrow set the bridge binds to by default. Anything else exposes the agent to
 * other hosts on the network and warrants a loud warning.
 * @param {string} host
 * @returns {boolean}
 */
export const isLoopbackHost = (host) => host === '127.0.0.1' || host === 'localhost' || host === '::1'

/**
 * Emit the loud security warnings shared by BOTH faces (ACP ws + MCP http) when
 * the user relaxes a default that fronts a privileged local agent: disabling the
 * Origin guard, or binding a non-loopback (LAN-reachable) host. Writes the human
 * text to stderr AND a structural lifecycle line to the logger (so it's testable
 * and PII-safe — `host` is a config scalar, never content). Each face calls this
 * at startup so the warning fires whatever protocol the user selected.
 * @param {object} cfg
 * @param {string} cfg.host
 * @param {boolean} cfg.allowAnyOrigin
 * @param {{ warn: (event: Record<string, unknown>) => void }} cfg.logger
 * @param {{ write: (s: string) => void }} [stream] - injectable for tests (default stderr)
 */
export const emitInsecureFlagWarnings = ({ host, allowAnyOrigin, logger }, stream = process.stderr) => {
  if (allowAnyOrigin) {
    logger.warn({ lifecycle: 'origin-check-disabled' })
    stream.write(
      '\nWARNING: --allow-any-origin is set — the Origin check is OFF.\n' +
        'Any web page open in a browser on this machine can connect to the bridge\n' +
        'and drive your agent. Use this only for trusted dev/self-host setups.\n',
    )
  }
  if (!isLoopbackHost(host)) {
    logger.warn({ lifecycle: 'non-loopback-host', host })
    stream.write(
      `\nWARNING: --host ${host} is not a loopback address — the bridge (and your\n` +
        'agent) is now reachable by other hosts on the network, not just this\n' +
        'machine. Keep the default 127.0.0.1 unless you really need remote access.\n',
    )
  }
}
