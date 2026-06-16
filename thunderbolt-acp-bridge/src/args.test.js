/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'bun:test'
import { parseArgs } from './args.js'

describe('parseArgs', () => {
  it('parses agent command after -- verbatim (no shell)', () => {
    const r = parseArgs(['--', 'npx', '-y', '@zed-industries/claude-code-acp'])
    expect(r.error).toBeNull()
    expect(r.agentCmd).toEqual(['npx', '-y', '@zed-industries/claude-code-acp'])
    expect(r.host).toBe('127.0.0.1')
    expect(r.port).toBe(0)
  })

  it('keeps agent flags that look like bridge flags (they are after --)', () => {
    const r = parseArgs(['--', 'my-agent', '--port', '9999', '--verbose'])
    expect(r.agentCmd).toEqual(['my-agent', '--port', '9999', '--verbose'])
    expect(r.port).toBe(0) // bridge port untouched
    expect(r.verbose).toBe(false)
  })

  it('parses --port before --', () => {
    const r = parseArgs(['--port', '8123', '--', 'agent'])
    expect(r.error).toBeNull()
    expect(r.port).toBe(8123)
    expect(r.agentCmd).toEqual(['agent'])
  })

  it('supports --port=NNNN form', () => {
    const r = parseArgs(['--port=8123', '--', 'agent'])
    expect(r.port).toBe(8123)
  })

  it('parses --host before --', () => {
    const r = parseArgs(['--host', '0.0.0.0', '--', 'agent'])
    expect(r.host).toBe('0.0.0.0')
    expect(r.error).toBeNull()
  })

  it('parses --verbose and --json', () => {
    const r = parseArgs(['--verbose', '--json', '--', 'agent'])
    expect(r.verbose).toBe(true)
    expect(r.json).toBe(true)
  })

  it('defaults the origin allowlist to empty extras and check enabled', () => {
    const r = parseArgs(['--', 'agent'])
    expect(r.allowOrigins).toEqual([])
    expect(r.allowAnyOrigin).toBe(false)
  })

  it('collects repeatable --allow-origin values', () => {
    const r = parseArgs(['--allow-origin', 'http://localhost:3000', '--allow-origin=https://dev.test', '--', 'agent'])
    expect(r.allowOrigins).toEqual(['http://localhost:3000', 'https://dev.test'])
    expect(r.error).toBeNull()
  })

  it('errors when --allow-origin is missing a value', () => {
    expect(parseArgs(['--allow-origin']).error).toBe('--allow-origin requires a value')
  })

  it('parses --allow-any-origin', () => {
    const r = parseArgs(['--allow-any-origin', '--', 'agent'])
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
})
