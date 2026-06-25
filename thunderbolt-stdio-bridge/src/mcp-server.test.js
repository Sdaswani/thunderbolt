/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const { test, expect, mock } = require('bun:test')
const { EventEmitter } = require('node:events')
const { createHash } = require('node:crypto')
const { startMcpFace, bearerMatches } = require('./mcp-server')

/** SHA-256 digest a string to a 32-byte buffer, matching the expected-bearer digest. */
const digest = (value) => createHash('sha256').update(value).digest()

/** A silent PII-safe logger spy. */
const makeLogger = () => ({
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  banner: mock(() => {}),
})

/** Fake http.Server: EventEmitter with listen/address/close. */
const makeFakeServer = () => {
  const server = new EventEmitter()
  server.listening = false
  server.listen = mock((port, host, cb) => {
    server._port = port === 0 ? 54321 : port
    server.listening = true
    queueMicrotask(cb)
    return server
  })
  server.address = () => ({ port: server._port })
  server.close = mock((cb) => {
    server.listening = false
    if (cb) queueMicrotask(cb)
    return server
  })
  server.closeAllConnections = mock(() => {})
  return server
}

/** Fake StreamableHTTPServerTransport. */
const makeFakeTransport = () => {
  const transport = {
    onmessage: null,
    send: mock(() => Promise.resolve()),
    handleRequest: mock(() => Promise.resolve()),
    close: mock(() => Promise.resolve()),
  }
  return transport
}

/** Fake superviseChild controller capturing wiring + calls. */
const makeFakeSupervisor = () => {
  const calls = { stdin: [], paused: 0, resumed: 0, stopped: 0, killed: 0 }
  const supervisor = {
    child: { stdin: new EventEmitter() },
    writeStdin: mock((chunk) => {
      calls.stdin.push(chunk.toString())
      return true
    }),
    pauseStdout: mock(() => {
      calls.paused += 1
    }),
    resumeStdout: mock(() => {
      calls.resumed += 1
    }),
    stop: mock(() => {
      calls.stopped += 1
    }),
    kill: mock(() => {
      calls.killed += 1
    }),
    alive: () => true,
  }
  return { supervisor, calls }
}

/** Build the injectable deps + capture the wired supervise hooks. */
const makeHarness = (overrides = {}) => {
  const server = makeFakeServer()
  const transport = makeFakeTransport()
  const { supervisor, calls } = makeFakeSupervisor()
  const hooks = {}
  const deps = {
    createServer: mock(() => server),
    StreamableHTTPServerTransport: class {
      constructor() {
        return transport
      }
    },
    superviseChild: mock((opts) => {
      hooks.onStdout = opts.onStdout
      hooks.onExit = opts.onExit
      hooks.onSpawnError = opts.onSpawnError
      return supervisor
    }),
    ...overrides,
  }
  return { server, transport, supervisor, calls, hooks, deps }
}

const baseOpts = (logger, deps, extra = {}) => ({
  launch: ['mcp-server'],
  host: '127.0.0.1',
  port: 0,
  allowOrigins: [],
  allowAnyOrigin: false,
  logger,
  deps,
  ...extra,
})

/** Fake request: an EventEmitter with method/url/headers + replayable body. */
const makeReq = ({ method = 'POST', url = '/mcp', headers = {}, body } = {}) => {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  req.destroy = mock(() => {})
  req.resume = mock(() => {})
  req._body = body
  return req
}

/** Fake response capturing status + end. */
const makeRes = () => {
  const res = {
    statusCode: null,
    headers: {},
    ended: false,
    writeHead: mock((status) => {
      res.statusCode = status
    }),
    setHeader: mock((k, v) => {
      res.headers[k] = v
    }),
    end: mock(() => {
      res.ended = true
    }),
  }
  return res
}

/** Emit a request through the server and replay its body chunks, then settle. */
const fireRequest = async (server, req, res) => {
  server.emit('request', req, res)
  if (req.method === 'POST') {
    // Let the request handler attach its data/end listeners first.
    await Promise.resolve()
    if (req._body !== undefined) req.emit('data', Buffer.from(req._body))
    req.emit('end')
  }
  // Drain microtasks so the async handler completes.
  await new Promise((r) => setTimeout(r, 0))
}

test('binds and resolves url http://127.0.0.1:PORT/mcp, calling logger.banner once', async () => {
  const logger = makeLogger()
  const { server, deps } = makeHarness()
  const face = await startMcpFace(baseOpts(logger, deps))
  expect(face.url).toBe('http://127.0.0.1:54321/mcp')
  expect(logger.banner).toHaveBeenCalledTimes(1)
  expect(logger.banner.mock.calls[0][0]).toBe('http://127.0.0.1:54321/mcp')
  expect(server.listen).toHaveBeenCalled()
})

test('bearer set: a request with no Authorization → 401 BEFORE routing/parsing', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps, { bearer: 'sekret' }))
  const req = makeReq({ headers: {}, body: '{"jsonrpc":"2.0"}' })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(res.statusCode).toBe(401)
  expect(transport.handleRequest).not.toHaveBeenCalled()
})

test('bearer set: an incorrect Authorization → 401', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps, { bearer: 'sekret' }))
  const req = makeReq({ headers: { authorization: 'Bearer wrong' } })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(res.statusCode).toBe(401)
  expect(transport.handleRequest).not.toHaveBeenCalled()
})

test('bearer set: a correct bearer passes and is dispatched', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps, { bearer: 'sekret' }))
  const req = makeReq({ headers: { authorization: 'Bearer sekret' }, body: '{"jsonrpc":"2.0","method":"ping"}' })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(transport.handleRequest).toHaveBeenCalledTimes(1)
})

test('bearerMatches: unequal-length inputs fail without throwing', () => {
  expect(() => bearerMatches('a', digest('abcdef'))).not.toThrow()
  expect(bearerMatches('a', digest('abcdef'))).toBe(false)
  expect(bearerMatches(undefined, digest('abc'))).toBe(false)
  expect(bearerMatches('abc', digest('abc'))).toBe(true)
})

test('bearerMatches: a SAME-LENGTH near-miss (32-byte digests differing by one byte) → false', () => {
  // Both operands are always 32-byte sha256 digests, so this exercises the real
  // constant-time path: equal-length buffers that differ in exactly one byte.
  const provided = 'sekret'
  const nearMiss = Buffer.from(digest(provided)) // copy of sha256(provided)
  nearMiss[0] ^= 0x01 // flip a single bit in one byte
  expect(nearMiss).toHaveLength(32)
  expect(bearerMatches(provided, nearMiss)).toBe(false)
  // Sanity: the un-flipped digest still matches.
  expect(bearerMatches(provided, digest(provided))).toBe(true)
})

test('CORS preflight (OPTIONS) returns 204 and allow-origin per allowlist', async () => {
  const logger = makeLogger()
  const { server, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  const req = makeReq({ method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(res.statusCode).toBe(204)
  expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173')
  // The MCP Streamable HTTP client sends Mcp-Protocol-Version on every request
  // after initialize; it MUST be allow-listed or the browser preflight fails.
  expect(res.headers['Access-Control-Allow-Headers']).toContain('Mcp-Protocol-Version')
})

test('--allow-any-origin echoes * for any Origin', async () => {
  const logger = makeLogger()
  const { server, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps, { allowAnyOrigin: true }))
  const req = makeReq({ method: 'OPTIONS', headers: { origin: 'http://evil.com' } })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(res.headers['Access-Control-Allow-Origin']).toBe('*')
})

test('a malformed JSON POST body → 400 and is not dispatched', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  const req = makeReq({ body: 'not json at all' })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(res.statusCode).toBe(400)
  expect(transport.handleRequest).not.toHaveBeenCalled()
})

test('a client that aborts the POST body (error) is dropped: no reply, no throw, no dispatch', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  const req = makeReq({ headers: {} })
  const res = makeRes()
  // No unhandledRejection escapes: readBody must never reject.
  const rejections = []
  const onRejection = (err) => rejections.push(err)
  process.on('unhandledRejection', onRejection)
  server.emit('request', req, res)
  await Promise.resolve() // let the handler attach its listeners
  req.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))
  await new Promise((r) => setTimeout(r, 0))
  process.removeListener('unhandledRejection', onRejection)
  expect(rejections).toHaveLength(0)
  expect(res.writeHead).not.toHaveBeenCalled()
  expect(res.end).not.toHaveBeenCalled()
  expect(transport.handleRequest).not.toHaveBeenCalled()
})

test('a client that closes the POST socket before end is dropped: no reply, no hang', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  const req = makeReq({ headers: {} })
  const res = makeRes()
  server.emit('request', req, res)
  await Promise.resolve()
  // Premature 'close' (no preceding 'end') => readBody resolves BODY_ABORTED and
  // the handler returns; the promise must resolve (otherwise this test hangs).
  req.emit('close')
  await new Promise((r) => setTimeout(r, 0))
  expect(res.writeHead).not.toHaveBeenCalled()
  expect(transport.handleRequest).not.toHaveBeenCalled()
})

test('a disallowed Origin is not granted CORS access', async () => {
  const logger = makeLogger()
  const { server, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  const req = makeReq({ method: 'OPTIONS', headers: { origin: 'http://evil.com' } })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined()
})

test('a present, disallowed Origin POST is hard-rejected 403 server-side and NOT dispatched', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  // A cross-origin simple POST is not preflighted; the server-side gate must
  // reject it (CSRF defense) rather than merely withholding the ACAO header.
  const req = makeReq({ headers: { origin: 'http://evil.com' }, body: '{"jsonrpc":"2.0","method":"tools/call","id":1}' })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(res.statusCode).toBe(403)
  expect(transport.handleRequest).not.toHaveBeenCalled()
})

test('an absent Origin is allowed (non-browser client) and dispatched', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  const req = makeReq({ headers: {}, body: '{"jsonrpc":"2.0","method":"ping","id":1}' })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(res.statusCode).not.toBe(403)
  expect(transport.handleRequest).toHaveBeenCalledTimes(1)
})

test('an allowed (loopback) Origin POST passes the gate and is dispatched', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  const req = makeReq({ headers: { origin: 'http://localhost:5173' }, body: '{"jsonrpc":"2.0","method":"ping","id":1}' })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(transport.handleRequest).toHaveBeenCalledTimes(1)
})

test('--allow-any-origin lets any Origin (incl. evil.com) through the gate and dispatch', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps, { allowAnyOrigin: true }))
  const req = makeReq({ headers: { origin: 'http://evil.com' }, body: '{"jsonrpc":"2.0","method":"ping","id":1}' })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(res.statusCode).not.toBe(403)
  expect(transport.handleRequest).toHaveBeenCalledTimes(1)
})

test('body exceeding bodyCapBytes → 413 and is not dispatched', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps, { bodyCapBytes: 8 }))
  const req = makeReq({ body: '{"a":"aaaaaaaaaaaaaaaa"}' })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(res.statusCode).toBe(413)
  expect(transport.handleRequest).not.toHaveBeenCalled()
})

test('a non-/mcp path → 404', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  const req = makeReq({ method: 'GET', url: '/nope' })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(res.statusCode).toBe(404)
  expect(transport.handleRequest).not.toHaveBeenCalled()
})

test('a non-/mcp path is still bearer-gated when bearer set', async () => {
  const logger = makeLogger()
  const { server, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps, { bearer: 'sekret' }))
  const req = makeReq({ method: 'GET', url: '/nope', headers: {} })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(res.statusCode).toBe(401)
})

test('POST /mcp is dispatched to transport.handleRequest with the parsed body', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  const req = makeReq({ body: '{"jsonrpc":"2.0","method":"initialize","id":1}' })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(transport.handleRequest).toHaveBeenCalledTimes(1)
  const parsed = transport.handleRequest.mock.calls[0][2]
  expect(parsed).toEqual({ jsonrpc: '2.0', method: 'initialize', id: 1 })
})

test('GET /mcp is dispatched to transport.handleRequest (SSE stream open)', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  const req = makeReq({ method: 'GET', url: '/mcp' })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(transport.handleRequest).toHaveBeenCalledTimes(1)
  // GET carries no body: handleRequest is invoked with exactly two args.
  expect(transport.handleRequest.mock.calls[0]).toHaveLength(2)
})

test('DELETE /mcp is dispatched to transport.handleRequest (session teardown)', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  const req = makeReq({ method: 'DELETE', url: '/mcp' })
  const res = makeRes()
  await fireRequest(server, req, res)
  expect(transport.handleRequest).toHaveBeenCalledTimes(1)
  expect(transport.handleRequest.mock.calls[0]).toHaveLength(2)
})

test('a rejecting transport.handleRequest is swallowed + logged, never escapes', async () => {
  const logger = makeLogger()
  const { server, transport, deps } = makeHarness()
  transport.handleRequest = mock(() => Promise.reject(Object.assign(new Error('gone'), { code: 'ERR_CLOSED' })))
  const rejections = []
  const onRejection = (err) => rejections.push(err)
  process.on('unhandledRejection', onRejection)
  await startMcpFace(baseOpts(logger, deps))
  const req = makeReq({ method: 'GET', url: '/mcp' })
  const res = makeRes()
  await fireRequest(server, req, res)
  await new Promise((r) => setTimeout(r, 0))
  process.removeListener('unhandledRejection', onRejection)
  expect(rejections).toHaveLength(0)
  expect(logger.warn).toHaveBeenCalled()
})

test('HTTP onmessage relays to child stdin as one NDJSON line', async () => {
  const logger = makeLogger()
  const { transport, calls, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  transport.onmessage({ jsonrpc: '2.0', method: 'ping', id: 7 })
  expect(calls.stdin).toHaveLength(1)
  expect(calls.stdin[0]).toBe('{"jsonrpc":"2.0","method":"ping","id":7}\n')
})

test('child stdout NDJSON lines are parsed and sent to the transport', async () => {
  const logger = makeLogger()
  const { transport, hooks, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  hooks.onStdout(Buffer.from('{"jsonrpc":"2.0","result":{},"id":7}\n'))
  expect(transport.send).toHaveBeenCalledTimes(1)
  expect(transport.send.mock.calls[0][0]).toEqual({ jsonrpc: '2.0', result: {}, id: 7 })
})

test('a rejecting transport.send (disconnected client) is swallowed + logged, never escapes', async () => {
  const logger = makeLogger()
  const { transport, hooks, deps } = makeHarness()
  // A stale/disconnected client makes the SDK reject; this must not surface as an
  // unhandledRejection (which the CLI's onFatal backstop would treat as fatal).
  transport.send = mock(() => Promise.reject(Object.assign(new Error('closed'), { code: 'ERR_CLOSED' })))
  const rejections = []
  const onRejection = (err) => rejections.push(err)
  process.on('unhandledRejection', onRejection)
  await startMcpFace(baseOpts(logger, deps))
  hooks.onStdout(Buffer.from('{"jsonrpc":"2.0","result":{},"id":7}\n'))
  await new Promise((r) => setTimeout(r, 0))
  process.removeListener('unhandledRejection', onRejection)
  expect(rejections).toHaveLength(0)
  expect(transport.send).toHaveBeenCalledTimes(1)
  expect(logger.warn).toHaveBeenCalled()
})

test('a malformed child stdout line is dropped + logged by method/id only, never sent', async () => {
  const logger = makeLogger()
  const { transport, hooks, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  hooks.onStdout(Buffer.from('not json\n'))
  expect(transport.send).not.toHaveBeenCalled()
  expect(logger.warn).toHaveBeenCalled()
})

test('child exit closes the http server + transport and resolves close()', async () => {
  const logger = makeLogger()
  const { server, transport, hooks, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  hooks.onExit({ code: 0, signal: null })
  expect(transport.close).toHaveBeenCalled()
  expect(server.close).toHaveBeenCalled()
})

test('child self-exit propagates to onChildExit with the exit info', async () => {
  const logger = makeLogger()
  const { hooks, deps } = makeHarness()
  const onChildExit = mock(() => {})
  await startMcpFace(baseOpts(logger, deps, { onChildExit }))
  hooks.onExit({ code: 0, signal: null })
  expect(onChildExit).toHaveBeenCalledTimes(1)
  expect(onChildExit).toHaveBeenCalledWith({ code: 0, signal: null })
})

test('child exit also force-closes lingering connections (closeAllConnections)', async () => {
  const logger = makeLogger()
  const { server, hooks, deps } = makeHarness()
  await startMcpFace(baseOpts(logger, deps))
  hooks.onExit({ code: 1, signal: null })
  expect(server.closeAllConnections).toHaveBeenCalled()
})

test('close() closes transport, stops the child, and closes the server: no orphan', async () => {
  const logger = makeLogger()
  const { server, transport, calls, deps } = makeHarness()
  const face = await startMcpFace(baseOpts(logger, deps))
  await face.close()
  expect(transport.close).toHaveBeenCalled()
  expect(calls.stopped).toBe(1)
  expect(server.close).toHaveBeenCalled()
})

test('close() AFTER the child self-exited resolves (no hang) and is idempotent', async () => {
  const logger = makeLogger()
  const { hooks, deps } = makeHarness()
  const face = await startMcpFace(baseOpts(logger, deps))
  // Drive the child self-exit first: this settles the close latch via finishClose.
  hooks.onExit({ code: 0, signal: null })
  // A close() on the already-settled latch must resolve immediately (setResolver
  // runs the resolver synchronously) rather than wait forever for a finishClose
  // that already fired.
  await face.close()
  // Idempotent: a second close() also resolves.
  await face.close()
})

test('close() force-closes lingering sockets and resolves deterministically (no hang)', async () => {
  const logger = makeLogger()
  const { server, deps } = makeHarness()
  // finishClose only fires once server.close's callback runs; lingering keep-alive
  // sockets would defer it forever without closeAllConnections.
  const face = await startMcpFace(baseOpts(logger, deps))
  await face.close() // resolving at all proves finishClose fired
  expect(server.close).toHaveBeenCalled()
  expect(server.closeAllConnections).toHaveBeenCalled()
})

test('the resolved face exposes kill() which immediately SIGKILLs the child', async () => {
  const logger = makeLogger()
  const { calls, deps } = makeHarness()
  const face = await startMcpFace(baseOpts(logger, deps))
  expect(typeof face.kill).toBe('function')
  face.kill()
  expect(calls.killed).toBe(1)
})

test('a spawn ENOENT rejects with an unavailable error and only closes the server (no kill — there is no child)', async () => {
  const logger = makeLogger()
  const { server, hooks, calls, deps } = makeHarness()
  const promise = startMcpFace(baseOpts(logger, deps))
  // superviseChild is invoked synchronously inside startMcpFace; trigger spawn error.
  hooks.onSpawnError(Object.assign(new Error('enoent'), { code: 'ENOENT' }))
  await expect(promise).rejects.toMatchObject({ name: 'UnavailableError', code: 'ENOENT' })
  expect(server.close).toHaveBeenCalled()
  // The child never spawned, so onSpawnError must not attempt a kill.
  expect(calls.killed).toBe(0)
})

test('a bind failure rejects with an unavailable error and SIGKILLs the child first', async () => {
  const logger = makeLogger()
  // Server whose listen never fires success but emits an error.
  const server = new EventEmitter()
  server.listen = mock(() => {
    queueMicrotask(() => server.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' })))
    return server
  })
  server.address = () => ({ port: 0 })
  server.close = mock(() => {})
  const { calls, deps } = makeHarness({ createServer: () => server })
  await expect(startMcpFace(baseOpts(logger, deps))).rejects.toMatchObject({
    name: 'UnavailableError',
    code: 'EADDRINUSE',
  })
  expect(calls.killed).toBe(1)
})
