/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'bun:test'
import { parseArgs } from './args.js'

describe('parseArgs', () => {
  it('parses agent command after -- verbatim (no shell)', () => {
    const r = parseArgs(['--mode', 'acp', '--', 'npx', '-y', '@zed-industries/claude-code-acp'])
    expect(r.error).toBeNull()
    expect(r.agentCmd).toEqual(['npx', '-y', '@zed-industries/claude-code-acp'])
    expect(r.host).toBe('127.0.0.1')
    expect(r.port).toBe(0)
  })

  it('keeps agent flags that look like bridge flags (they are after --)', () => {
    const r = parseArgs(['--mode', 'acp', '--', 'my-agent', '--port', '9999', '--verbose'])
    expect(r.agentCmd).toEqual(['my-agent', '--port', '9999', '--verbose'])
    expect(r.port).toBe(0) // bridge port untouched
    expect(r.verbose).toBe(false)
  })

  it('parses --port before --', () => {
    const r = parseArgs(['--mode', 'acp', '--port', '8123', '--', 'agent'])
    expect(r.error).toBeNull()
    expect(r.port).toBe(8123)
    expect(r.agentCmd).toEqual(['agent'])
  })

  it('supports --port=NNNN form', () => {
    const r = parseArgs(['--mode', 'acp', '--port=8123', '--', 'agent'])
    expect(r.port).toBe(8123)
  })

  it('parses --host before --', () => {
    const r = parseArgs(['--mode', 'acp', '--host', '0.0.0.0', '--', 'agent'])
    expect(r.host).toBe('0.0.0.0')
    expect(r.error).toBeNull()
  })

  it('requires --mode (errors when omitted)', () => {
    const r = parseArgs(['--', 'agent'])
    expect(r.mode).toBeNull()
    expect(r.error).toBe('--mode is required (acp or mcp)')
  })

  it('parses --mode acp and --mode mcp (and the --mode=value form)', () => {
    expect(parseArgs(['--mode', 'acp', '--', 'agent']).mode).toBe('acp')
    expect(parseArgs(['--mode=acp', '--', 'agent']).mode).toBe('acp')
    expect(parseArgs(['--mode', 'mcp', '--', 'agent']).mode).toBe('mcp')
    expect(parseArgs(['--mode=mcp', '--', 'agent']).mode).toBe('mcp')
  })

  it('errors on an unknown --mode value', () => {
    expect(parseArgs(['--mode', 'grpc', '--', 'agent']).error).toBe('invalid --mode: grpc (expected acp or mcp)')
  })

  it('errors when --mode is missing a value', () => {
    expect(parseArgs(['--mode']).error).toBe('--mode requires a value (acp or mcp)')
  })

  it('parses --verbose and --json', () => {
    const r = parseArgs(['--mode', 'acp', '--verbose', '--json', '--', 'agent'])
    expect(r.verbose).toBe(true)
    expect(r.json).toBe(true)
  })

  it('defaults the origin allowlist to empty extras and check enabled', () => {
    const r = parseArgs(['--mode', 'acp', '--', 'agent'])
    expect(r.allowOrigins).toEqual([])
    expect(r.allowAnyOrigin).toBe(false)
  })

  it('collects repeatable --allow-origin values', () => {
    const r = parseArgs([
      '--mode',
      'acp',
      '--allow-origin',
      'http://localhost:3000',
      '--allow-origin=https://dev.test',
      '--',
      'agent',
    ])
    expect(r.allowOrigins).toEqual(['http://localhost:3000', 'https://dev.test'])
    expect(r.error).toBeNull()
  })

  it('errors when --allow-origin is missing a value', () => {
    expect(parseArgs(['--allow-origin']).error).toBe('--allow-origin requires a value')
  })

  it('parses --allow-any-origin', () => {
    const r = parseArgs(['--mode', 'acp', '--allow-any-origin', '--', 'agent'])
    expect(r.allowAnyOrigin).toBe(true)
  })

  it('sets help (and short -h)', () => {
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
  })

  it('sets version (and short -v)', () => {
    expect(parseArgs(['--version']).version).toBe(true)
    expect(parseArgs(['-v']).version).toBe(true)
  })

  it('errors when no -- separator is present (suggests --)', () => {
    const r = parseArgs(['agent', 'arg'])
    expect(r.error).toContain('no agent command given')
    expect(r.error).toContain('--')
  })

  it('errors when -- is present but no command follows', () => {
    const r = parseArgs(['--port', '8080', '--'])
    expect(r.error).toBe('no agent command given')
  })

  it('errors on unknown option before --', () => {
    const r = parseArgs(['--nope', '--', 'agent'])
    expect(r.error).toBe('unknown option: --nope')
  })

  it('errors on non-integer port', () => {
    expect(parseArgs(['--port', 'abc', '--', 'agent']).error).toBe('invalid --port: abc')
  })

  it('errors on out-of-range port', () => {
    expect(parseArgs(['--port', '99999', '--', 'agent']).error).toBe('invalid --port: 99999')
  })

  it('errors when --host is missing a value', () => {
    expect(parseArgs(['--host']).error).toBe('--host requires a value')
  })

  it('always exposes help text', () => {
    expect(parseArgs([]).helpText).toContain('Usage:')
    expect(parseArgs([]).helpText).toContain('Add Custom Agent')
  })

  it('defaults --tunnel to false', () => {
    expect(parseArgs(['--mode', 'acp', '--', 'agent']).tunnel).toBe(false)
  })

  it('parses --tunnel with --mode mcp', () => {
    const r = parseArgs(['--mode', 'mcp', '--tunnel', '--', 'agent'])
    expect(r.error).toBeNull()
    expect(r.tunnel).toBe(true)
    expect(r.mode).toBe('mcp')
  })

  it('requires --mode even with --tunnel (mode check precedes the tunnel gate)', () => {
    const r = parseArgs(['--tunnel', '--', 'agent'])
    expect(r.tunnel).toBe(true)
    expect(r.mode).toBeNull()
    expect(r.error).toBe('--mode is required (acp or mcp)')
  })

  it('rejects --tunnel with explicit --mode acp', () => {
    const r = parseArgs(['--mode', 'acp', '--tunnel', '--', 'agent'])
    expect(r.error).toContain('--tunnel is not allowed with --mode acp')
    expect(r.error).toContain('localhost-only')
  })
})
