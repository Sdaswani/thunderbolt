/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * MCP Streamable HTTP face for thunderbolt-stdio-bridge.
 *
 * Unlike the ACP/WebSocket face (a stateless byte relay), MCP is a STATEFUL
 * transport: sessions, id-correlation, content negotiation, and SSE routing all
 * matter. We do NOT hand-roll any of that — the official MCP SDK's
 * `StreamableHTTPServerTransport` is driven as a BARE TRANSPORT ADAPTER (no
 * semantic McpServer):
 *
 *   client HTTP  --handleRequest-->  transport  --onmessage-->  child stdin
 *   child stdout  --line-->  transport.send  --SSE/JSON-->  client HTTP
 *
 * The SDK owns Mcp-Session-Id minting, POST→json correlation by JSON-RPC id,
 * the GET SSE stream for server-initiated traffic, and 202 for notification-only
 * POSTs. We own the security envelope (Origin allowlist, CORS, body cap, bearer)
 * and the deterministic teardown when the child dies with requests pending.
 *
 * Single MCP session per child (one transport instance). A loopback bridge is a
 * 1:1 user→agent pipe, so a second session is neither needed nor offered.
 *
 * Dependencies (http server factory, transport factory, child, line reader,
 * clock) are injected so the whole face is exercisable with fakes — no real
 * sockets in unit tests.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'

import { isOriginAllowed, sanitizeOrigin, defaultAllowedOrigins, classifyKind, safeMethod } from './log.js'
import { parseRpcObject } from './relay.js'
import { resolvePort, emitInsecureFlagWarnings } from './util.js'

/** Cap on a single request body. MCP messages are small JSON-RPC frames; a
 *  multi-MB POST to a localhost agent bridge is never legitimate and is a cheap
 *  memory-exhaustion vector, so reject it before buffering. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** JSON-RPC error code for an internal server condition (child gone). */
const JSONRPC_INTERNAL_ERROR = -32603

const CORS_ALLOW_METHODS = 'POST, GET, OPTIONS, DELETE'
const CORS_ALLOW_HEADERS = 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version'

/**
 * Start the MCP Streamable HTTP face. Resolves once the HTTP server is listening
 * AND the child has survived the grace window (mirroring the ACP face), with the
 * resolved port; the caller prints the banner.
 *
 * @param {object} cfg
 * @param {import('node:child_process').ChildProcess} cfg.child - the spawned stdio MCP server
 * @param {import('node:events').EventEmitter} cfg.lines - line reader over child.stdout (emits 'line')
 * @param {string} cfg.host
 * @param {number} cfg.port - 0 = ephemeral
 * @param {string[]} [cfg.allowOrigins] - extra Origins beyond the Thunderbolt defaults
 * @param {boolean} [cfg.allowAnyOrigin] - disable the Origin check entirely (loud escape hatch)
 * @param {string | null} [cfg.requiredBearer] - when set, every /mcp request must carry `Authorization: Bearer <secret>`
 * @param {ReturnType<import('./log.js').createLogger>} cfg.logger
 * @param {object} deps
 * @param {() => { listen: Function, on: Function, address: Function, close: Function }} deps.createHttpServer - factory taking the request handler
 * @param {() => McpTransport} deps.createTransport - bare StreamableHTTP transport factory
 * @returns {Promise<{ port: number, close: () => void }>}
 */
export const startMcpFace = (cfg, deps) => {
  const { child, lines, host, port, allowOrigins = [], allowAnyOrigin = false, requiredBearer = null, logger } = cfg
  const { createHttpServer, createTransport } = deps

  // Same loud warnings the ACP face emits — disabling the Origin guard or binding
  // a non-loopback host fronts a privileged agent and must alert the user in BOTH modes.
  emitInsecureFlagWarnings({ host, allowAnyOrigin, logger })

  const allowlist = [...defaultAllowedOrigins, ...allowOrigins]
  const transport = createTransport()
  // Streamable HTTP's start() is a no-op (connections are per-request), but the
  // Transport contract requires it before handleRequest — call it for spec
  // correctness and forward-compat.
  transport.start?.()

  // --- bare adapter wiring: transport <-> child stdio ----------------------
  // transport message (client→server JSON-RPC) → child stdin as one ndjson line.
  transport.onmessage = (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`)
    logger.debug(extractMcpEvent({ direction: 'client->agent', message }))
  }
  transport.onerror = () => {
    // The transport surfaces protocol-shape errors (bad Accept, unsupported
    // protocol version, etc.). The SDK's message can echo attacker-controlled
    // header text, so log ONLY the fixed lifecycle label — never the raw message.
    logger.warn({ lifecycle: 'mcp-transport-error' })
  }

  // child stdout line → transport.send. The SDK correlates a response to its
  // pending POST by JSON-RPC id, or routes a server-initiated request/
  // notification (unmatched id / no id) to the GET SSE stream.
  lines.on('line', (rawLine) => {
    const line = rawLine.replace(/\r$/, '')
    const message = parseRpcObject(line)
    if (message === null) {
      // A non-JSON / non-object stdout line (agent log noise that escaped the
      // 'inherit' stderr): drop it. Log only its byte length — never the text.
      logger.warn({ lifecycle: 'mcp-dropped-non-rpc', byteSize: Buffer.byteLength(line) })
      return
    }
    // send() rejects when the child answers an id with no open stream (a late or
    // out-of-order response after the client gave up). That's expected churn,
    // not a crash — swallow it to a debug lifecycle line.
    transport.send(message).then(
      () => logger.debug(extractMcpEvent({ direction: 'agent->client', message })),
      // The rejection reason can contain a raw JSON-RPC id — log only the label.
      () => logger.debug({ lifecycle: 'mcp-send-unmatched' }),
    )
  })

  // Responses delegated to the SDK transport but not yet answered. The SDK does
  // NOT resolve a pending JSON-response POST when the transport is closed, so on
  // child death we must end these ourselves — otherwise an in-flight client hangs
  // until its own timeout instead of getting the promised deterministic error.
  /** @type {Set<import('node:http').ServerResponse>} */
  const openResponses = new Set()

  // --- deterministic teardown on child death --------------------------------
  // If the child exits, close the transport AND fail any still-open delegated
  // response with a 503 (or end an already-streaming SSE), so in-flight clients
  // get a clean, immediate failure rather than a hang. The shared lifecycle
  // (server.js / cli.js) owns the actual process exit.
  child.on('exit', () => {
    logger.info({ lifecycle: 'mcp-child-exited' })
    transport.close()
    for (const res of openResponses) {
      if (res.writableEnded) continue
      if (res.headersSent) res.end()
      else endJson(res, 503, jsonRpcError(JSONRPC_INTERNAL_ERROR, 'Agent process exited'))
    }
    openResponses.clear()
  })

  return new Promise((resolve, reject) => {
    const server = createHttpServer((req, res) => {
      const ctx = { req, res, transport, allowlist, allowAnyOrigin, requiredBearer, child, logger, openResponses }
      handleRequest(ctx).catch((err) => {
        // A handler-level failure must never crash the process; answer 500. Log
        // ONLY the error code (a fixed Node string) — never err.message, which can
        // echo request-derived content and break the bridge's PII-safe logging.
        logger.error({ lifecycle: 'mcp-handler-error', errorCode: err?.code })
        if (!res.headersSent) endJson(res, 500, jsonRpcError(JSONRPC_INTERNAL_ERROR, 'Internal bridge error'))
      })
    })

    server.on('error', (err) => {
      logger.error({ lifecycle: 'mcp-server-error', errorCode: err?.code })
      reject(Object.assign(new Error(`MCP HTTP server error (${err?.code ?? 'unknown'})`), { exitCode: 69 }))
    })

    server.listen(port, host, () => {
      const resolvedPort = resolvePort(server, port)
      logger.info({ lifecycle: 'mcp-listening', port: resolvedPort })
      // close() is the face teardown the supervisor calls on shutdown: drop the
      // http listener AND end the SDK transport (closes every open POST/SSE
      // stream). transport.close is idempotent, so the child-exit handler above
      // closing it too is harmless.
      resolve({
        port: resolvedPort,
        close: () => {
          server.close()
          transport.close()
        },
      })
    })
  })
}

/**
 * Handle one inbound HTTP request to the MCP face: enforce the security envelope
 * (CORS preflight, Origin, bearer, body cap), then delegate to the SDK transport.
 *
 * @param {object} args
 * @param {import('node:http').IncomingMessage} args.req
 * @param {import('node:http').ServerResponse} args.res
 * @param {McpTransport} args.transport
 * @param {readonly string[]} args.allowlist
 * @param {boolean} args.allowAnyOrigin
 * @param {string | null} args.requiredBearer
 * @param {import('node:child_process').ChildProcess} args.child
 * @param {ReturnType<import('./log.js').createLogger>} args.logger
 * @param {Set<import('node:http').ServerResponse>} args.openResponses - tracks delegated responses for child-exit failure
 */
const handleRequest = async ({
  req,
  res,
  transport,
  allowlist,
  allowAnyOrigin,
  requiredBearer,
  child,
  logger,
  openResponses,
}) => {
  const rawOrigin = req.headers.origin
  const origin = sanitizeOrigin(rawOrigin)
  const originOk = allowAnyOrigin || isOriginAllowed(rawOrigin, allowlist)

  // CORS preflight: answer it ourselves (the SDK transport doesn't). A preflight
  // can't carry credentials (Fetch spec), so it precedes the bearer gate; the
  // actual request still passes through every check below.
  if (req.method === 'OPTIONS') {
    setCors(res, rawOrigin, originOk)
    res.writeHead(204)
    res.end()
    return
  }

  // Origin allowlist — MCP spec REQUIRES this (DNS-rebinding defense). A present
  // Origin must match; a missing Origin is allowed (native/Tauri webviews send
  // none, and over a tunnel the bearer below is the real gate).
  if (!originOk) {
    logger.warn({ lifecycle: 'mcp-origin-rejected', origin })
    endJson(res, 403, jsonRpcError(JSONRPC_INTERNAL_ERROR, 'Origin not allowed'))
    return
  }

  // Bearer gate (set by the tunnel phase; unset on plain localhost). It precedes
  // EVERY route — including the health probe — so a public tunnel never exposes
  // even liveness without the secret.
  if (requiredBearer !== null && !hasValidBearer(req, requiredBearer)) {
    logger.warn({ lifecycle: 'mcp-unauthorized' })
    setCors(res, rawOrigin, originOk)
    res.setHeader('WWW-Authenticate', 'Bearer')
    endJson(res, 401, jsonRpcError(JSONRPC_INTERNAL_ERROR, 'Unauthorized'))
    return
  }

  setCors(res, rawOrigin, originOk)

  // Health probe (now behind origin + bearer). Cheap liveness for the banner/operator.
  if (req.method === 'GET' && isHealthPath(req.url)) {
    endJson(res, 200, { ok: true })
    return
  }

  // Only the /mcp endpoint is served; anything else is 404 (keep the surface tight).
  if (!isMcpPath(req.url)) {
    endJson(res, 404, jsonRpcError(JSONRPC_INTERNAL_ERROR, 'Not found'))
    return
  }

  const childGone = () => child.exitCode !== null || child.signalCode !== null

  // The child has already died: answer deterministically instead of letting the
  // transport hang an SSE/POST against a dead pipe.
  if (childGone()) {
    logger.warn({ lifecycle: 'mcp-child-gone' })
    endJson(res, 503, jsonRpcError(JSONRPC_INTERNAL_ERROR, 'Agent process exited'))
    return
  }

  // Track this response BEFORE reading the body so a child death at ANY point —
  // including during a slow upload — fails it via the child-exit flush rather
  // than hanging (the SDK won't resolve a pending JSON POST on transport.close()).
  openResponses.add(res)
  res.on('close', () => openResponses.delete(res))

  const body = await readBody(req)
  // The child-exit flush may have already ended this response while the body was
  // uploading — never write to an ended response.
  if (res.writableEnded) return
  if (body === OVERSIZED) {
    logger.warn({ lifecycle: 'mcp-body-too-large' })
    endJson(res, 413, jsonRpcError(JSONRPC_INTERNAL_ERROR, 'Request body too large'))
    return
  }
  // Re-check after the await: the child may have exited during readBody before
  // the flush reached this res. Don't delegate to a dead child.
  if (childGone()) {
    logger.warn({ lifecycle: 'mcp-child-gone' })
    endJson(res, 503, jsonRpcError(JSONRPC_INTERNAL_ERROR, 'Agent process exited'))
    return
  }

  // Empty body on a GET/DELETE is normal; a POST body is parsed JSON-RPC. Invalid
  // JSON is handed to the SDK as `undefined` so it returns the spec error.
  const parsed = body.length === 0 ? undefined : parseRpcObject(body)
  await transport.handleRequest(req, res, parsed ?? undefined)
}

/** Sentinel distinguishing an oversized body from a legitimate empty body. */
const OVERSIZED = Symbol('oversized')

/**
 * Buffer the request body with a hard size cap. Returns the body string, or the
 * OVERSIZED sentinel if the declared/streamed size exceeds the cap.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string | typeof OVERSIZED>}
 */
const readBody = (req) => {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return Promise.resolve(OVERSIZED)

  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        resolve(OVERSIZED)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Set CORS headers. Echo the Origin only for an allowed cross-origin request so
 * the browser can read the response (and the Mcp-Session-Id it must reuse).
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} rawOrigin
 * @param {boolean} originOk
 */
const setCors = (res, rawOrigin, originOk) => {
  if (typeof rawOrigin === 'string' && rawOrigin.length > 0 && originOk) {
    res.setHeader('Access-Control-Allow-Origin', rawOrigin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS)
  res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS)
  // The browser client must read the session id cross-origin to reuse it.
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id')
}

/**
 * Constant-time bearer check against the configured secret. Uses
 * `timingSafeEqual` so a network attacker can't recover the secret via the
 * per-byte short-circuit of `===` (a prefix-timing oracle over the tunnel). The
 * length guard avoids `timingSafeEqual`'s throw on unequal lengths — the secret
 * length (base64url of 32 bytes) is fixed and not itself sensitive.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} secret
 * @returns {boolean}
 */
const hasValidBearer = (req, secret) => {
  const header = req.headers.authorization
  const prefix = 'Bearer '
  if (typeof header !== 'string' || !header.startsWith(prefix)) return false
  const provided = Buffer.from(header.slice(prefix.length))
  const expected = Buffer.from(secret)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

/**
 * Build a JSON-RPC error envelope (id null — these are transport-level failures
 * not tied to a specific client request).
 * @param {number} code
 * @param {string} message
 * @returns {{ jsonrpc: '2.0', error: { code: number, message: string }, id: null }}
 */
const jsonRpcError = (code, message) => ({ jsonrpc: '2.0', error: { code, message }, id: null })

/**
 * Write a JSON response and end. No-op if the response was already sent.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
const endJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Extract a PII-safe MCP log event: only the JSON-RPC shape (kind/method/id),
 * never params/result. Reuses the structural fields the ACP logger uses.
 * @param {object} args
 * @param {'client->agent' | 'agent->client'} args.direction
 * @param {Record<string, unknown>} args.message
 * @returns {{ direction: string, kind: string, method?: string, hasId: boolean }}
 */
const extractMcpEvent = ({ direction, message }) => ({
  direction,
  kind: classifyKind(message),
  // safeMethod collapses unknown/attacker-supplied methods to 'other' (and the
  // notifications/* family to one label) so a method string can't smuggle content.
  method: safeMethod(message.method),
  hasId: 'id' in message,
})

/** The request path without query, defaulting `/` for a missing url. */
const pathOf = (url) => (typeof url === 'string' ? url.split('?')[0] : '/')

/** Whether a URL path is the root health probe. */
const isHealthPath = (url) => pathOf(url) === '/'

/** Whether a URL path is the MCP endpoint. */
const isMcpPath = (url) => pathOf(url) === '/mcp'

/** Mint a fresh session id. Exported for the CLI wiring to pass into the SDK. */
export const newSessionId = () => randomUUID()

/**
 * @typedef {object} McpTransport
 * @property {(message: unknown) => void} [onmessage]
 * @property {(err: Error) => void} [onerror]
 * @property {(message: unknown, options?: object) => Promise<void>} send
 * @property {(req: unknown, res: unknown, body?: unknown) => Promise<void>} handleRequest
 * @property {() => Promise<void> | void} [start]
 * @property {() => Promise<void> | void} close
 */
