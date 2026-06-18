/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'bun:test'
import {
  exitCodes,
  usageError,
  spawnError,
  serverError,
  tunnelError,
  earlyExitError,
} from './errors.js'

describe('exitCodes', () => {
  it('uses sysexits-style codes', () => {
    expect(exitCodes).toEqual({ ok: 0, usage: 64, unavailable: 69, dependencyMissing: 70, interrupted: 130 })
  })
})

describe('usageError', () => {
  it('maps to exit 64 and prefixes the reason', () => {
    const r = usageError('no agent command given')
    expect(r.exitCode).toBe(64)
    expect(r.message).toBe('thunderbolt-stdio-bridge: no agent command given')
  })
})

describe('spawnError', () => {
  it('maps ENOENT to an actionable "command not found" + exit 69', () => {
    const r = spawnError({ code: 'ENOENT' }, { cmd0: 'my-agent' })
    expect(r.exitCode).toBe(69)
    expect(r.message).toContain('command not found: my-agent')
    expect(r.message).toContain('PATH')
  })

  it('maps EACCES to permission denied + exit 69', () => {
    const r = spawnError({ code: 'EACCES' }, { cmd0: 'my-agent' })
    expect(r.exitCode).toBe(69)
    expect(r.message).toContain('permission denied')
    expect(r.message).toContain('my-agent')
  })

  it('falls back for unknown spawn errors', () => {
    const r = spawnError({ code: 'EWHATEVER' }, { cmd0: 'x' })
    expect(r.exitCode).toBe(69)
    expect(r.message).toContain('EWHATEVER')
  })

  it('never leaks argv beyond cmd0', () => {
    const r = spawnError({ code: 'ENOENT' }, { cmd0: 'agent' })
    expect(r.message).not.toContain('--secret-token')
  })
})

describe('serverError', () => {
  it('maps EADDRINUSE to a port-in-use message + exit 69', () => {
    const r = serverError({ code: 'EADDRINUSE' }, { host: '127.0.0.1', port: 8080 })
    expect(r.exitCode).toBe(69)
    expect(r.message).toContain('127.0.0.1:8080')
    expect(r.message).toContain('--port')
  })

  it('handles EADDRINUSE without an explicit port', () => {
    const r = serverError({ code: 'EADDRINUSE' }, {})
    expect(r.message).toContain('the requested port')
  })

  it('falls back for unknown server errors', () => {
    const r = serverError({ code: 'EACCES' }, {})
    expect(r.exitCode).toBe(69)
    expect(r.message).toContain('EACCES')
  })
})

describe('tunnelError', () => {
  it('maps a missing cloudflared (ENOENT) to an install hint + exit 70', () => {
    const r = tunnelError({ code: 'ENOENT' })
    expect(r.exitCode).toBe(70)
    expect(r.message).toContain('cloudflared not found')
    expect(r.message).toContain('install it')
  })

  it('maps an abnormal cloudflared exit to exit 69 with the reason', () => {
    const r = tunnelError({ reason: 'exited early (code 1)' })
    expect(r.exitCode).toBe(69)
    expect(r.message).toContain('exited early (code 1)')
  })

  it('falls back for an unknown tunnel error code', () => {
    const r = tunnelError({ code: 'EPIPE' })
    expect(r.exitCode).toBe(69)
    expect(r.message).toContain('EPIPE')
  })
})

describe('earlyExitError', () => {
  it('reports the exit code path + exit 69', () => {
    const r = earlyExitError({ code: 1, signal: null, cmd0: 'agent' })
    expect(r.exitCode).toBe(69)
    expect(r.message).toContain('code 1')
    expect(r.message).toContain('agent')
  })

  it('reports a signal when the agent was killed', () => {
    const r = earlyExitError({ code: null, signal: 'SIGKILL', cmd0: 'agent' })
    expect(r.message).toContain('signal SIGKILL')
  })
})
