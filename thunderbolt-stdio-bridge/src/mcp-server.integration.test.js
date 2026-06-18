/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * End-to-end MCP face test: spawn a REAL stdio MCP server
 * (@modelcontextprotocol/server-everything), bridge it through the real
 * `startMcpFace` (real node:http + real SDK transport), and drive it with the
 * OFFICIAL StreamableHTTPClientTransport. This proves the bare-adapter contract
 * (session minting, id-correlation, content negotiation) against a real client.
 *
 * Offline-tolerant: if the MCP server can't be spawned (no network, package not
 * cached), the suite skips with a clear message rather than failing CI.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { startMcpFace, newSessionId } from './mcp-server.js'
import { createLogger } from './log.js'

const quietLogger = () => createLogger({ stream: { write: () => {} } })

/** Probe whether the real MCP server can start; resolves true within `ms`. */
const canSpawnServerEverything = (ms = 8000) =>
  new Promise((resolve) => {
    const child = spawn('npx', ['-y', '@modelcontextprotocol/server-everything'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const done = (ok) => {
      child.removeAllListeners()
      child.kill('SIGKILL')
      resolve(ok)
    }
    child.on('error', () => done(false))
    // It prints a startup line to stderr (ignored) but stays alive; if it
    // survives a beat without erroring, treat it as available.
    const timer = setTimeout(() => done(true), 1500)
    child.on('exit', () => {
      clearTimeout(timer)
      done(false)
    })
    setTimeout(() => done(false), ms)
  })

const available = await canSpawnServerEverything()

const suite = available ? describe : describe.skip
if (!available) {
  // eslint-disable-next-line no-console
  console.warn('[mcp integration] skipped — @modelcontextprotocol/server-everything could not be spawned (offline?)')
}

suite('MCP face — real server-everything via official client', () => {
  let child
  let close
  let port
  let Client
  let StreamableHTTPClientTransport
  let StreamableHTTPServerTransport

  beforeAll(async () => {
    ;({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'))
    ;({ StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js'))
    ;({ StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js'))

    child = spawn('npx', ['-y', '@modelcontextprotocol/server-everything'], { stdio: ['pipe', 'pipe', 'ignore'] })
    const lines = createInterface({ input: child.stdout })

    ;({ port, close } = await startMcpFace(
      { child, lines, host: '127.0.0.1', port: 0, logger: quietLogger() },
      {
        createHttpServer: (handler) => createServer(handler),
        createTransport: () =>
          new StreamableHTTPServerTransport({ sessionIdGenerator: newSessionId, enableJsonResponse: true }),
      },
    ))
  })

  afterAll(() => {
    close?.()
    child?.kill('SIGKILL')
  })

  const connectClient = async () => {
    const client = new Client({ name: 'integration-test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    await client.connect(transport)
    return client
  }

  it('initialize + tools/list + tools/call round-trips through the bridge', async () => {
    const client = await connectClient()
    const tools = await client.listTools()
    expect(tools.tools.length).toBeGreaterThan(0)
    expect(tools.tools.map((t) => t.name)).toContain('echo')

    const result = await client.callTool({ name: 'echo', arguments: { message: 'thunderbolt' } })
    expect(JSON.stringify(result.content)).toContain('thunderbolt')

    await client.close()
  }, 20000)
})
