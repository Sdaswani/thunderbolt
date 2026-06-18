/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'bun:test'
import { EventEmitter } from 'node:events'
import { startMcpFace } from './mcp-server.js'
import { createLogger } from './log.js'

const ALLOWED_ORIGIN = 'https://app.thunderbolt.io'

/** A fake stdio child: records stdin writes, emits exit. */
const makeFakeChild = () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.stdin = {
    written: [],
    write(chunk) {
      this.written.push(chunk)
      return true
    },
  }
  child.kill = () => true
  return child
}

/** A fake line reader: emits 'line' on demand. */
const makeFakeLines = () => new EventEmitter()

/**
 * A fake StreamableHTTP transport that captures the adapter wiring without any
 * real HTTP. It records onmessage/send and lets the test drive handleRequest
 * outcomes through a recorder.
 */
const makeFakeTransport = () => {
  const transport = {
    started: false,
    closed: false,
    sent: [],
    handled: [],
    sendBehavior: () => Promise.resolve(),
    start() {
      this.started = true
    },
    send(message) {
      this.sent.push(message)
      return this.sendBehavior(message)
    },
    handleRequest(req, res, body) {
      this.handled.push({ method: req.method, body })
      // Mimic the SDK answering a POST with 200 + JSON so the test can assert
      // delegation happened. Real correlation is covered by the integration test.
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}')
      return Promise.resolve()
    },
    close() {
      this.closed = true
    },
  }
  return transport
}

/** A fake http.Server the test drives (listen → callback, capture handler). */
const makeFakeHttpServer = (port) => {
  const server = new EventEmitter()
  server.handler = null
  server.closed = false
  server.address = () => ({ port })
  server.listen = (_port, _host, cb) => {
    cb()
    return server
  }
  server.close = () => {
    server.closed = true
  }
  return server
}

/** A fake ServerResponse capturing status/headers/body. Like a real
 *  ServerResponse it is an EventEmitter (has `on`), exposes `writableEnded`, and
 *  emits 'close' when ended — so the face's open-response tracking works. */
const makeFakeRes = () => {
  const res = new EventEmitter()
  res.statusCode = null
  res.headers = {}
  res.body = ''
  res.headersSent = false
  res.writableEnded = false
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v
  }
  res.writeHead = (status, headers) => {
    res.statusCode = status
    res.headersSent = true
    if (headers) for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = v
    return res
  }
  res.end = (chunk) => {
    if (chunk) res.body += chunk
    res.ended = true
    res.writableEnded = true
    res.emit('close')
  }
  return res
}

/** A fake IncomingMessage: a readable stream of one body chunk + headers. */
const makeFakeReq = ({ method = 'POST', url = '/mcp', headers = {}, body = '' } = {}) => {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  req.destroy = () => {
    req.destroyed = true
  }
  // Emit the body asynchronously so handlers attach listeners first.
  queueMicrotask(() => {
    if (body.length > 0) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

const quietLogger = () => createLogger({ stream: { write: () => {} } })

/** Start the face with fakes and return the moving parts + a request driver. */
const startFace = async ({
  cfg = {},
  child = makeFakeChild(),
  lines = makeFakeLines(),
  transport = makeFakeTransport(),
} = {}) => {
  const server = makeFakeHttpServer(7000)
  const { port, close } = await startMcpFace(
    { child, lines, host: '127.0.0.1', port: 0, logger: quietLogger(), ...cfg },
    {
      createHttpServer: (handler) => {
        server.handler = handler
        return server
      },
      createTransport: () => transport,
    },
  )

  /** Drive one request through the captured handler; resolves when res ends. */
  const request = async (reqOpts) => {
    const req = makeFakeReq(reqOpts)
    const res = makeFakeRes()
    server.handler(req, res)
    await waitFor(() => res.ended === true)
    return res
  }

  return { child, lines, transport, server, port, close, request }
}

const waitFor = async (pred, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 1))
  }
}

describe('startMcpFace — bare adapter wiring', () => {
  it('starts the transport and resolves with the listening port', async () => {
    const { transport, port } = await startFace()
    expect(transport.started).toBe(true)
    expect(port).toBe(7000)
  })

  it('transport.onmessage writes the JSON-RPC message to child stdin as one ndjson line', async () => {
    const { child, transport } = await startFace()
    transport.onmessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(child.stdin.written).toEqual(['{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'])
  })

  it('child stdout line is parsed and forwarded to transport.send', async () => {
    const { lines, transport } = await startFace()
    lines.emit('line', '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}')
    await waitFor(() => transport.sent.length === 1)
    expect(transport.sent[0]).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
  })

  it('handles out-of-order child responses (each forwarded independently)', async () => {
    const { lines, transport } = await startFace()
    lines.emit('line', '{"jsonrpc":"2.0","id":2,"result":{}}')
    lines.emit('line', '{"jsonrpc":"2.0","id":1,"result":{}}')
    await waitFor(() => transport.sent.length === 2)
    expect(transport.sent.map((m) => m.id)).toEqual([2, 1])
  })

  it('an unmatched-response send rejection does NOT crash (swallowed to debug)', async () => {
    const transport = makeFakeTransport()
    transport.sendBehavior = () => Promise.reject(new Error('No connection established for request ID: 99'))
    const { lines } = await startFace({ transport })
    // Should not throw / reject anywhere observable.
    lines.emit('line', '{"jsonrpc":"2.0","id":99,"result":{}}')
    await new Promise((r) => setTimeout(r, 5))
    expect(true).toBe(true)
  })

  it('drops an invalid-JSON stdout line without forwarding', async () => {
    const { lines, transport } = await startFace()
    lines.emit('line', 'not json at all')
    lines.emit('line', '42') // bare scalar — not a JSON-RPC object
    await new Promise((r) => setTimeout(r, 5))
    expect(transport.sent).toEqual([])
  })

  it('closes the transport when the child exits', async () => {
    const child = makeFakeChild()
    const { transport } = await startFace({ child })
    child.exitCode = 0
    child.emit('exit', 0, null)
    expect(transport.closed).toBe(true)
  })
})

describe('startMcpFace — POST delegation + 202 path', () => {
  it('delegates a POST with a parsed body to transport.handleRequest', async () => {
    const { transport, request } = await startFace()
    const res = await request({
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN, 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    })
    expect(res.statusCode).toBe(200)
    expect(transport.handled).toHaveLength(1)
    expect(transport.handled[0].body).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' })
  })

  it('passes undefined body for invalid JSON so the SDK returns its own error', async () => {
    const { transport, request } = await startFace()
    await request({ method: 'POST', headers: { origin: ALLOWED_ORIGIN }, body: '{not json' })
    expect(transport.handled[0].body).toBeUndefined()
  })
})

describe('startMcpFace — child gone', () => {
  it('returns a deterministic 503 + JSON-RPC error when the child already exited', async () => {
    const child = makeFakeChild()
    child.exitCode = 1
    const { request } = await startFace({ child })
    const res = await request({ method: 'POST', headers: { origin: ALLOWED_ORIGIN }, body: '{"id":1}' })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ jsonrpc: '2.0', error: { message: 'Agent process exited' } })
  })

  it('fails an IN-FLIGHT delegated request with 503 when the child exits mid-flight (no hang)', async () => {
    // A transport that delegates but never answers — the request is in flight.
    const inflight = makeFakeTransport()
    inflight.handleRequest = (req) => {
      inflight.handled.push({ method: req.method })
      return Promise.resolve() // leaves res open, mimicking a pending JSON POST
    }
    const child = makeFakeChild()
    const { server } = await startFace({ child, transport: inflight })
    const req = makeFakeReq({ method: 'POST', url: '/mcp', headers: { origin: ALLOWED_ORIGIN }, body: '{"id":1}' })
    const res = makeFakeRes()
    server.handler(req, res)
    await waitFor(() => inflight.handled.length === 1) // delegated; res still open
    expect(res.ended).toBeUndefined()
    // Child dies while the request is pending → deterministic 503, not a hang.
    child.exitCode = 1
    child.emit('exit', 1, null)
    await waitFor(() => res.ended === true)
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ jsonrpc: '2.0', error: { message: 'Agent process exited' } })
  })

  it('fails a request whose body is STILL UPLOADING when the child exits (tracked before readBody)', async () => {
    const inflight = makeFakeTransport()
    const child = makeFakeChild()
    const { server } = await startFace({ child, transport: inflight })
    // A request that never finishes uploading (emits no 'end'): the handler is
    // parked on `await readBody`, so it has NOT delegated yet.
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/mcp'
    req.headers = { origin: ALLOWED_ORIGIN }
    req.destroy = () => {}
    const res = makeFakeRes()
    server.handler(req, res)
    await new Promise((r) => setTimeout(r, 5)) // let the handler reach readBody (res now tracked)
    expect(res.ended).toBeUndefined()
    expect(inflight.handled.length).toBe(0) // never delegated
    // Child dies mid-upload → the flush must 503 the already-tracked response.
    child.exitCode = 1
    child.emit('exit', 1, null)
    await waitFor(() => res.ended === true)
    expect(res.statusCode).toBe(503)
    req.emit('end') // let the parked readBody resolve; it bails on res.writableEnded
  })
})

describe('startMcpFace — Origin allowlist (DNS-rebinding defense)', () => {
  it('accepts an allowed Thunderbolt origin', async () => {
    const { request } = await startFace()
    const res = await request({ method: 'POST', headers: { origin: ALLOWED_ORIGIN }, body: '{"id":1}' })
    expect(res.statusCode).toBe(200)
  })

  it('rejects a disallowed origin with 403 and does NOT delegate', async () => {
    const { transport, request } = await startFace()
    const res = await request({ method: 'POST', headers: { origin: 'https://evil.example' }, body: '{"id":1}' })
    expect(res.statusCode).toBe(403)
    expect(transport.handled).toEqual([])
  })

  it('allows a missing origin (native/Tauri webviews send none)', async () => {
    const { request } = await startFace()
    const res = await request({ method: 'POST', headers: {}, body: '{"id":1}' })
    expect(res.statusCode).toBe(200)
  })

  it('--allow-any-origin accepts a junk origin', async () => {
    const { request } = await startFace({ cfg: { allowAnyOrigin: true } })
    const res = await request({ method: 'POST', headers: { origin: 'https://evil.example' }, body: '{"id":1}' })
    expect(res.statusCode).toBe(200)
  })
})

describe('startMcpFace — CORS preflight', () => {
  it('answers OPTIONS with 204 and the correct CORS headers for an allowed origin', async () => {
    const { request } = await startFace()
    const res = await request({ method: 'OPTIONS', headers: { origin: ALLOWED_ORIGIN } })
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    expect(res.headers['access-control-allow-methods']).toContain('POST')
    expect(res.headers['access-control-allow-methods']).toContain('DELETE')
    expect(res.headers['access-control-allow-headers']).toContain('Authorization')
    expect(res.headers['access-control-allow-headers']).toContain('Mcp-Session-Id')
    expect(res.headers['access-control-expose-headers']).toBe('Mcp-Session-Id')
  })

  it('does NOT echo the Origin for a disallowed origin in preflight', async () => {
    const { request } = await startFace()
    const res = await request({ method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('startMcpFace — bearer auth', () => {
  it('rejects /mcp with 401 when a bearer is required and absent', async () => {
    const { transport, request } = await startFace({ cfg: { requiredBearer: 's3cret' } })
    const res = await request({ method: 'POST', headers: { origin: ALLOWED_ORIGIN }, body: '{"id":1}' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer')
    expect(transport.handled).toEqual([])
  })

  it('rejects with 401 on a wrong bearer', async () => {
    const { request } = await startFace({ cfg: { requiredBearer: 's3cret' } })
    const res = await request({
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN, authorization: 'Bearer wrong' },
      body: '{"id":1}',
    })
    expect(res.statusCode).toBe(401)
  })

  it('accepts (delegates) with the correct bearer', async () => {
    const { transport, request } = await startFace({ cfg: { requiredBearer: 's3cret' } })
    const res = await request({
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN, authorization: 'Bearer s3cret' },
      body: '{"id":1}',
    })
    expect(res.statusCode).toBe(200)
    expect(transport.handled).toHaveLength(1)
  })

  it('requires NO bearer when unset (plain localhost)', async () => {
    const { request } = await startFace()
    const res = await request({ method: 'POST', headers: { origin: ALLOWED_ORIGIN }, body: '{"id":1}' })
    expect(res.statusCode).toBe(200)
  })
})

describe('startMcpFace — body cap', () => {
  it('rejects an oversized body (declared Content-Length) with 413', async () => {
    const { request } = await startFace()
    const res = await request({
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN, 'content-length': String(5 * 1024 * 1024) },
      body: '{"id":1}',
    })
    expect(res.statusCode).toBe(413)
  })
})

describe('startMcpFace — health probe', () => {
  it('answers GET / with {ok:true}', async () => {
    const { request } = await startFace()
    const res = await request({ method: 'GET', url: '/', headers: { origin: ALLOWED_ORIGIN } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
  })
})

describe('startMcpFace — insecure-flag warnings (parity with ACP)', () => {
  it('emits the loud warnings in MCP mode when the Origin guard is off AND the host is non-loopback', async () => {
    const warned = []
    const logger = { debug() {}, info() {}, warn: (e) => warned.push(e), error() {} }
    await startFace({ cfg: { allowAnyOrigin: true, host: '0.0.0.0', logger } })
    expect(warned.some((e) => e.lifecycle === 'origin-check-disabled')).toBe(true)
    expect(warned.some((e) => e.lifecycle === 'non-loopback-host')).toBe(true)
  })

  it('stays silent on the safe defaults (loopback host, Origin guard on)', async () => {
    const warned = []
    const logger = { debug() {}, info() {}, warn: (e) => warned.push(e), error() {} }
    await startFace({ cfg: { allowAnyOrigin: false, host: '127.0.0.1', logger } })
    expect(warned.some((e) => e.lifecycle === 'origin-check-disabled' || e.lifecycle === 'non-loopback-host')).toBe(
      false,
    )
  })
})
