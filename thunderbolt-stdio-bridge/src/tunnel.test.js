/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'bun:test'
import { EventEmitter } from 'node:events'
import { startTunnel, generateBearer, parseTrycloudflareUrl } from './tunnel.js'
import { createLogger } from './log.js'

const quietLogger = () => createLogger({ stream: { write: () => {} } })

/**
 * A fake cloudflared child: stdout/stderr are EventEmitters, kill records the
 * signals it received and flips exitCode so stop()'s guards behave.
 */
const makeFakeCloudflared = () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = []
  child.kill = (sig) => {
    child.killed.push(sig)
    return true
  }
  return child
}

/** An injectable spawn returning a preset child and recording its argv. */
const makeFakeSpawn = (child) => {
  const calls = []
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return child
  }
  return { spawn, calls }
}

describe('generateBearer', () => {
  it('returns a long url-safe secret with no padding/url-unsafe chars', () => {
    const a = generateBearer()
    const b = generateBearer()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(40)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('parseTrycloudflareUrl', () => {
  it('extracts the public URL from a cloudflared log line', () => {
    const line =
      '2024-01-01T00:00:00Z INF +--------------------------------------------------------+\n' +
      '|  Your quick Tunnel has been created! Visit it at:      |\n' +
      '|  https://random-funny-words-1234.trycloudflare.com     |\n'
    expect(parseTrycloudflareUrl(line)).toBe('https://random-funny-words-1234.trycloudflare.com')
  })

  it('returns null when no trycloudflare URL is present', () => {
    expect(parseTrycloudflareUrl('Starting tunnel...')).toBeNull()
  })
})

describe('startTunnel', () => {
  it('spawns cloudflared with the loopback --url and resolves on the announced URL', async () => {
    const child = makeFakeCloudflared()
    const { spawn, calls } = makeFakeSpawn(child)
    const promise = startTunnel({ host: '127.0.0.1', port: 7777, logger: quietLogger() }, { spawn })

    // cloudflared announces the URL on stderr.
    child.stderr.emit('data', Buffer.from('Visit it at: https://abc-def.trycloudflare.com\n'))

    const result = await promise
    expect(calls[0].cmd).toBe('cloudflared')
    expect(calls[0].args).toEqual(['tunnel', '--url', 'http://127.0.0.1:7777'])
    expect(result.publicUrl).toBe('https://abc-def.trycloudflare.com')
    expect(result.mcpUrl).toBe('https://abc-def.trycloudflare.com/mcp')
  })

  it('also parses the URL when cloudflared prints it on stdout', async () => {
    const child = makeFakeCloudflared()
    const { spawn } = makeFakeSpawn(child)
    const promise = startTunnel({ host: '127.0.0.1', port: 80, logger: quietLogger() }, { spawn })
    child.stdout.emit('data', 'https://xyz.trycloudflare.com')
    const result = await promise
    expect(result.mcpUrl).toBe('https://xyz.trycloudflare.com/mcp')
  })

  it('rejects with an actionable error + exit code 70 when cloudflared is missing (ENOENT)', async () => {
    const child = makeFakeCloudflared()
    const { spawn } = makeFakeSpawn(child)
    const promise = startTunnel({ host: '127.0.0.1', port: 1, logger: quietLogger() }, { spawn })
    child.emit('error', Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' }))
    await expect(promise).rejects.toMatchObject({ exitCode: 70 })
    await promise.catch((err) => expect(err.message).toContain('cloudflared not found'))
  })

  it('rejects with exit code 69 when cloudflared exits before announcing a URL', async () => {
    const child = makeFakeCloudflared()
    const { spawn } = makeFakeSpawn(child)
    const promise = startTunnel({ host: '127.0.0.1', port: 1, logger: quietLogger() }, { spawn })
    child.exitCode = 1
    child.emit('exit', 1, null)
    await expect(promise).rejects.toMatchObject({ exitCode: 69 })
  })

  it('stop() hard-kills the ephemeral cloudflared tunnel (SIGKILL, no graceful state)', async () => {
    const child = makeFakeCloudflared()
    const { spawn } = makeFakeSpawn(child)
    const promise = startTunnel({ host: '127.0.0.1', port: 7777, logger: quietLogger() }, { spawn })
    child.stderr.emit('data', 'https://a.trycloudflare.com')
    const { stop } = await promise

    stop()
    expect(child.killed).toEqual(['SIGKILL'])
  })

  it('stop() does not signal a cloudflared child that already exited', async () => {
    const child = makeFakeCloudflared()
    const { spawn } = makeFakeSpawn(child)
    const promise = startTunnel({ host: '127.0.0.1', port: 7777, logger: quietLogger() }, { spawn })
    child.stderr.emit('data', 'https://a.trycloudflare.com')
    const { stop } = await promise

    child.exitCode = 0 // already gone
    stop()
    expect(child.killed).toEqual([])
  })

  it('hands stop() back synchronously via onStop, before any URL — so a teardown mid-startup still kills cloudflared', () => {
    const child = makeFakeCloudflared()
    const { spawn } = makeFakeSpawn(child)
    let captured = null
    // No URL is ever emitted: onStop must have fired synchronously on spawn.
    startTunnel({ host: '127.0.0.1', port: 7777, logger: quietLogger() }, { spawn, onStop: (s) => (captured = s) })
    expect(typeof captured).toBe('function')
    captured()
    expect(child.killed).toEqual(['SIGKILL'])
  })

  it('ignores a late URL announcement after an early-exit rejection (no double-settle)', async () => {
    const child = makeFakeCloudflared()
    const { spawn } = makeFakeSpawn(child)
    const promise = startTunnel({ host: '127.0.0.1', port: 1, logger: quietLogger() }, { spawn })
    child.emit('exit', 1, null)
    await expect(promise).rejects.toMatchObject({ exitCode: 69 })
    // A stray late line must not throw / re-settle.
    expect(() => child.stderr.emit('data', 'https://late.trycloudflare.com')).not.toThrow()
  })
})
