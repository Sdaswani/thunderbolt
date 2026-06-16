/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'bun:test'
import { EventEmitter } from 'node:events'
import { wireAgentToWs, frameForStdin, handleWsMessage } from './relay.js'

describe('wireAgentToWs (agent stdout -> ws)', () => {
  const setup = () => {
    const lines = new EventEmitter()
    const sent = []
    const dropped = []
    const detach = wireAgentToWs({
      lines,
      send: (line) => sent.push(line),
      onDrop: (line) => dropped.push(line),
    })
    return { lines, sent, dropped, detach }
  }

  it('forwards each non-empty JSON line as one ws frame (multi-line chunk -> multi-frame)', () => {
    const { lines, sent } = setup()
    // readline already splits chunks into lines; simulate three lines arriving.
    lines.emit('line', '{"jsonrpc":"2.0","id":1,"method":"initialize"}')
    lines.emit('line', '{"jsonrpc":"2.0","id":2,"method":"session/new"}')
    lines.emit('line', '{"jsonrpc":"2.0","method":"session/update"}')

    expect(sent).toHaveLength(3)
    expect(sent[0]).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}')
    expect(sent[2]).toBe('{"jsonrpc":"2.0","method":"session/update"}')
  })

  it('each frame is exactly one JSON object (Thunderbolt JSON.parse-safe)', () => {
    const { lines, sent } = setup()
    lines.emit('line', '{"a":1}')
    lines.emit('line', '{"b":2}')
    for (const frame of sent) {
      expect(() => JSON.parse(frame)).not.toThrow()
    }
  })

  it('drops non-JSON lines (does not forward) and reports them', () => {
    const { lines, sent, dropped } = setup()
    lines.emit('line', 'Starting agent v1.2.3...')
    lines.emit('line', '{"jsonrpc":"2.0","id":1}')
    lines.emit('line', 'plain log line')

    expect(sent).toEqual(['{"jsonrpc":"2.0","id":1}'])
    expect(dropped).toEqual(['Starting agent v1.2.3...', 'plain log line'])
  })

  it('skips empty and whitespace-only lines', () => {
    const { lines, sent, dropped } = setup()
    lines.emit('line', '')
    lines.emit('line', '   ')
    lines.emit('line', '\t')
    lines.emit('line', '{"ok":true}')

    expect(sent).toEqual(['{"ok":true}'])
    expect(dropped).toEqual([]) // empties are skipped, not "dropped"
  })

  it('strips a trailing carriage return (CRLF agents)', () => {
    const { lines, sent } = setup()
    lines.emit('line', '{"id":1}\r')
    expect(sent).toEqual(['{"id":1}'])
  })

  it('drops bare scalars and arrays — a real ACP frame is always a JSON object', () => {
    const { lines, sent, dropped } = setup()
    lines.emit('line', '123')
    lines.emit('line', '"x"')
    lines.emit('line', 'true')
    lines.emit('line', 'null')
    lines.emit('line', '[]')
    lines.emit('line', '[{"id":1}]')
    lines.emit('line', '{"id":1}') // the only forwardable object

    expect(sent).toEqual(['{"id":1}'])
    expect(dropped).toEqual(['123', '"x"', 'true', 'null', '[]', '[{"id":1}]'])
  })

  it('detach removes the listener', () => {
    const { lines, sent, detach } = setup()
    detach()
    lines.emit('line', '{"id":1}')
    expect(sent).toEqual([])
  })
})

describe('frameForStdin (ws -> agent stdin framing)', () => {
  it('appends exactly one trailing newline', () => {
    expect(frameForStdin('{"id":1}')).toBe('{"id":1}\n')
  })

  it('does not double the newline if the sender already added one', () => {
    expect(frameForStdin('{"id":1}\n')).toBe('{"id":1}\n')
    expect(frameForStdin('{"id":1}\n\n')).toBe('{"id":1}\n')
  })

  it('handles Buffer payloads', () => {
    expect(frameForStdin(Buffer.from('{"id":2}'))).toBe('{"id":2}\n')
  })

  it('handles ArrayBuffer payloads', () => {
    const ab = new TextEncoder().encode('{"id":3}').buffer
    expect(frameForStdin(ab)).toBe('{"id":3}\n')
  })

  it('handles fragmented Buffer[] payloads', () => {
    expect(frameForStdin([Buffer.from('{"id'), Buffer.from('":4}')])).toBe('{"id":4}\n')
  })

  it('returns null for empty messages (nothing to write)', () => {
    expect(frameForStdin('')).toBeNull()
    expect(frameForStdin(Buffer.from(''))).toBeNull()
  })
})

describe('handleWsMessage', () => {
  it('writes the framed message to stdin', () => {
    const written = []
    handleWsMessage({ data: '{"id":1}', write: (chunk) => written.push(chunk) })
    expect(written).toEqual(['{"id":1}\n'])
  })

  it('writes nothing for an empty message', () => {
    const written = []
    handleWsMessage({ data: '', write: (chunk) => written.push(chunk) })
    expect(written).toEqual([])
  })
})
