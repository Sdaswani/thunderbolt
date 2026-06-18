/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'bun:test'
import { EventEmitter } from 'node:events'
import { superviseChild } from './child.js'
import { createLogger } from './log.js'

/**
 * A fake child process: pipes for stdin/stdout, emits exit/error. Mirrors the
 * server.test.js fake so the supervisor sees the same shapes the faces do.
 *
 * @param {{ ignoreSigterm?: boolean }} [opts] - when ignoreSigterm is set, the
 *   child records the signal but does NOT die on SIGTERM (only on SIGKILL),
 *   modeling a stubborn agent so the escalation path can be tested.
 */
const makeFakeChild = ({ ignoreSigterm = false } = {}) => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.stdin = Object.assign(new EventEmitter(), {
    written: [],
    write(chunk) {
      this.written.push(chunk)
      return true
    },
  })
  child.stdout = new EventEmitter()
  child.killed = []
  child.kill = (sig) => {
    child.killed.push(sig)
    if (sig === 'SIGTERM' && ignoreSigterm) return true
    child.exitCode = 0
    child.signalCode = sig
    queueMicrotask(() => child.emit('exit', 0, sig))
    return true
  }
  return child
}

const quietLogger = () => createLogger({ stream: { write: () => {} } })

/**
 * Drive a supervisor with fakes and capture every seam the face would receive.
 * Tiny grace/escalation windows keep the tests fast.
 */
const supervise = ({ child = makeFakeChild(), graceMs = 20, killEscalationMs = 20 } = {}) => {
  const calls = { ready: 0, closeFace: [], fatal: [], exit: [] }
  const lines = new EventEmitter()
  const result = superviseChild(
    { agentCmd: ['my-agent', '--flag'], logger: quietLogger(), graceMs, killEscalationMs },
    {
      spawn: () => child,
      createLineReader: () => lines,
      onReady: () => {
        calls.ready += 1
      },
      closeFace: (reason) => calls.closeFace.push(reason),
      onFatalRejection: (err) => calls.fatal.push(err),
      exit: (code) => calls.exit.push(code),
    },
  )
  return { ...result, calls, lines }
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms))

describe('superviseChild — spawn + line reader', () => {
  it('spawns with inherited stderr and returns the line reader', () => {
    const child = makeFakeChild()
    const { child: returned, lines } = supervise({ child })
    expect(returned).toBe(child)
    expect(lines).toBeInstanceOf(EventEmitter)
  })
})

describe('superviseChild — grace window', () => {
  it('fires onReady once after the child survives the grace window', async () => {
    const { calls } = supervise({ graceMs: 20 })
    expect(calls.ready).toBe(0) // not yet — still inside the window
    await tick(40)
    expect(calls.ready).toBe(1)
    await tick(40)
    expect(calls.ready).toBe(1) // strictly once
  })

  it('does NOT fire onReady if the child dies inside the grace window', async () => {
    const { child, calls } = supervise({ graceMs: 40 })
    child.emit('exit', 1, null) // dies before grace elapses
    await tick(60)
    expect(calls.ready).toBe(0)
  })
})

describe('superviseChild — early child exit (before ready)', () => {
  it('maps an early exit to earlyExitError/unavailable and rejects + exits 69', async () => {
    const { child, calls } = supervise({ graceMs: 60 })
    child.emit('exit', 1, null)
    await tick(0)
    expect(calls.fatal).toHaveLength(1)
    expect(calls.fatal[0].exitCode).toBe(69)
    expect(calls.fatal[0].message).toContain('before it was ready')
    expect(calls.closeFace).toContain('going-away')
    expect(calls.exit).toEqual([69])
  })
})

describe('superviseChild — spawn error', () => {
  it('maps spawn ENOENT to spawnError/unavailable, rejects, closes the face, and never orphans', async () => {
    const child = makeFakeChild()
    const { calls } = supervise({ child, graceMs: 60 })
    child.emit('error', Object.assign(new Error('spawn my-agent ENOENT'), { code: 'ENOENT' }))
    await tick(0)
    expect(calls.fatal).toHaveLength(1)
    expect(calls.fatal[0].exitCode).toBe(69)
    expect(calls.fatal[0].message).toContain('command not found')
    expect(calls.closeFace).toContain('going-away')
    // Never-orphan: a live child is SIGKILLed before exit.
    expect(child.killed).toContain('SIGKILL')
    expect(calls.exit).toEqual([69])
  })
})

describe('superviseChild — never-orphan safeExit', () => {
  it('SIGKILLs a still-alive child on a fatal face error and exits once', () => {
    const child = makeFakeChild() // alive: exitCode/signalCode null
    const { safeExit, calls } = supervise({ child, graceMs: 60 })
    safeExit(69) // the face hit a fatal error (e.g. server bind failure)
    expect(child.killed).toContain('SIGKILL')
    expect(calls.exit).toEqual([69])
  })
})

describe('superviseChild — signal stop', () => {
  it("SIGTERMs the child, closes the face with 'normal', and exits with the stop code once it dies", async () => {
    const { child, stop, calls } = supervise()
    stop('signal', 130)
    expect(calls.closeFace).toContain('normal')
    expect(child.killed).toContain('SIGTERM')
    await tick(0)
    expect(calls.exit).toEqual([130])
  })

  it('escalates SIGTERM → SIGKILL after the window for a stubborn child, then exits', async () => {
    const stubborn = makeFakeChild({ ignoreSigterm: true })
    const { stop, calls } = supervise({ child: stubborn, killEscalationMs: 20 })
    stop('signal', 130)
    expect(stubborn.killed).toEqual(['SIGTERM'])
    await tick(0)
    expect(calls.exit).toEqual([]) // SIGTERM ignored → not dead yet
    await tick(40)
    expect(stubborn.killed).toEqual(['SIGTERM', 'SIGKILL'])
    expect(calls.exit).toEqual([130])
  })
})

describe('superviseChild — agent exit after ready', () => {
  it("closes the face with 'going-away' and exits 0 on a clean agent exit", async () => {
    const { child, calls } = supervise({ graceMs: 20 })
    await tick(40) // pass grace → ready
    child.emit('exit', 0, null)
    await tick(0)
    expect(calls.closeFace).toContain('going-away')
    expect(calls.exit).toEqual([0])
  })

  it('exits 69 when a ready agent dies by signal (code null) or non-zero', async () => {
    const { child, calls } = supervise({ graceMs: 20 })
    await tick(40)
    child.emit('exit', null, 'SIGKILL')
    await tick(0)
    expect(calls.exit).toEqual([69])
  })
})
