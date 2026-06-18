/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'bun:test'
import { resolvePort, formatHostForUrl, isLoopbackHost, emitInsecureFlagWarnings } from './util.js'

describe('resolvePort', () => {
  it('returns the OS-assigned port from address()', () => {
    expect(resolvePort({ address: () => ({ port: 54321 }) }, 0)).toBe(54321)
  })
  it('falls back to the requested port when address() is unusable', () => {
    expect(resolvePort({ address: () => null }, 8000)).toBe(8000)
    expect(resolvePort({ address: () => 'pipe' }, 8000)).toBe(8000)
    expect(resolvePort({}, 8000)).toBe(8000)
  })
})

describe('formatHostForUrl', () => {
  it('brackets a bare IPv6 literal', () => {
    expect(formatHostForUrl('::1')).toBe('[::1]')
  })
  it('leaves IPv4 / hostnames untouched and does not double-bracket', () => {
    expect(formatHostForUrl('127.0.0.1')).toBe('127.0.0.1')
    expect(formatHostForUrl('localhost')).toBe('localhost')
    expect(formatHostForUrl('[::1]')).toBe('[::1]')
  })
})

describe('isLoopbackHost', () => {
  it('accepts the loopback set the bridge binds to by default', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1']) expect(isLoopbackHost(h)).toBe(true)
  })
  it('rejects non-loopback binds', () => {
    for (const h of ['0.0.0.0', '192.168.1.5', '::']) expect(isLoopbackHost(h)).toBe(false)
  })
})

describe('emitInsecureFlagWarnings', () => {
  const capture = () => {
    const warned = []
    const written = []
    const logger = { debug() {}, info() {}, warn: (e) => warned.push(e), error() {} }
    const stream = { write: (s) => written.push(s) }
    return { warned, written, logger, stream }
  }

  it('warns (logger + stderr) when the Origin guard is disabled', () => {
    const { warned, written, logger, stream } = capture()
    emitInsecureFlagWarnings({ host: '127.0.0.1', allowAnyOrigin: true, logger }, stream)
    expect(warned.some((e) => e.lifecycle === 'origin-check-disabled')).toBe(true)
    expect(written.join('')).toContain('--allow-any-origin')
    expect(warned.some((e) => e.lifecycle === 'non-loopback-host')).toBe(false) // loopback host → no host warning
  })

  it('warns when binding a non-loopback host (LAN exposure)', () => {
    const { warned, written, logger, stream } = capture()
    emitInsecureFlagWarnings({ host: '0.0.0.0', allowAnyOrigin: false, logger }, stream)
    expect(warned.some((e) => e.lifecycle === 'non-loopback-host')).toBe(true)
    expect(written.join('')).toContain('not a loopback address')
    expect(warned.some((e) => e.lifecycle === 'origin-check-disabled')).toBe(false)
  })

  it('stays silent on the safe defaults (loopback host, Origin guard on)', () => {
    const { warned, written, logger, stream } = capture()
    emitInsecureFlagWarnings({ host: '127.0.0.1', allowAnyOrigin: false, logger }, stream)
    expect(warned).toEqual([])
    expect(written).toEqual([])
  })
})
