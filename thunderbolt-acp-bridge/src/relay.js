/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Pure framing relay between an ACP stdio agent and a Thunderbolt WebSocket.
 *
 * Two different framings meet here:
 *   - ACP stdio = ndjson: newline-delimited JSON-RPC, one object per line.
 *   - Thunderbolt WS = one JSON object per WebSocket message.
 *
 * The bridge's whole job is to translate between them:
 *   - agent stdout → ws: split into lines, send each non-empty JSON line as ONE
 *     ws frame. Line-splitting is mandatory — a raw stdout chunk can contain
 *     several lines (or a partial line), and Thunderbolt does an unguarded
 *     `JSON.parse(event.data)` per message, so each frame MUST be exactly one
 *     JSON object.
 *   - ws message → agent stdin: write the message verbatim plus a trailing '\n'
 *     so the agent's ndjson reader sees one complete line.
 *
 * Non-JSON stdout lines are DROPPED (never forwarded) and reported via `onDrop`,
 * protecting Thunderbolt's unguarded parse. Empty lines are skipped silently.
 *
 * This module is pure wiring: it takes a readline interface (already created
 * over child.stdout), a `send` function, and a `write` function. No spawning,
 * no sockets — fully unit-testable with fakes.
 */

/**
 * Determine whether a stdout line is a forwardable JSON-RPC frame.
 *
 * A real ACP frame is ALWAYS a JSON object. Bare scalars/arrays (`123`, `"x"`,
 * `true`, `null`, `[]`) are never valid JSON-RPC, so they're junk — drop them
 * rather than forward them to Thunderbolt's unguarded parse.
 * @param {string} line
 * @returns {boolean}
 */
const isForwardableJson = (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false
  try {
    const parsed = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/**
 * Wire the agent→ws direction: for each line emitted by the readline interface,
 * forward it as one ws frame if it is non-empty valid JSON, otherwise drop it.
 *
 * @param {object} args
 * @param {import('node:events').EventEmitter} args.lines - emits 'line' events (a readline.Interface)
 * @param {(line: string) => void} args.send - sends one ws frame (caller guards readyState)
 * @param {(line: string) => void} [args.onForward] - observability hook for a forwarded line
 * @param {(line: string) => void} [args.onDrop] - called with a dropped non-JSON line
 * @returns {() => void} detach function removing the listener
 */
export const wireAgentToWs = ({ lines, send, onForward, onDrop }) => {
  const handler = (rawLine) => {
    const line = rawLine.replace(/\r$/, '')
    if (line.trim().length === 0) return
    if (!isForwardableJson(line)) {
      onDrop?.(line)
      return
    }
    send(line)
    onForward?.(line)
  }
  lines.on('line', handler)
  return () => lines.off('line', handler)
}

/**
 * Frame a single ws message for the agent's stdin: stringify Buffers, append the
 * mandatory trailing newline. Empty messages produce `null` (nothing to write).
 *
 * @param {string | Buffer | ArrayBuffer | Buffer[]} data - the ws message payload
 * @returns {string | null}
 */
export const frameForStdin = (data) => {
  const text = wsDataToString(data)
  if (text.length === 0) return null
  // Strip any trailing newline the sender added, then add exactly one.
  return `${text.replace(/\n+$/, '')}\n`
}

/**
 * Handle one inbound ws message: frame it and write to the agent's stdin.
 *
 * @param {object} args
 * @param {string | Buffer | ArrayBuffer | Buffer[]} args.data - ws message payload
 * @param {(chunk: string) => void} args.write - writes to child.stdin
 * @param {(chunk: string) => void} [args.onWrite] - observability hook
 */
export const handleWsMessage = ({ data, write, onWrite }) => {
  const framed = frameForStdin(data)
  if (framed === null) return
  write(framed)
  onWrite?.(framed)
}

/**
 * Normalize the various ws message payload shapes into a UTF-8 string.
 * @param {string | Buffer | ArrayBuffer | Buffer[]} data
 * @returns {string}
 */
const wsDataToString = (data) => {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}
