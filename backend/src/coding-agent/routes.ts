/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { registerAgentProvider } from '@/agents'
import type { Auth } from '@/auth/elysia-plugin'
import { authorizeWsBearer } from '@/auth/ws-bearer-auth'
import { createStandaloneLogger } from '@/config/logger'
import type { Settings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import type { User } from '@shared/types/auth'
import { Elysia } from 'elysia'
import { createCodingAgentProvider } from './provider'
import { provisionWorkspaceToken } from './provision'
import { CodingAgentProxy, type UpstreamFactory } from './proxy'

/** Carrier subprotocol echoed back so strict WS clients complete the upgrade. */
const wsCarrierSubprotocol = 'thunderbolt.v1'

/** Auth failed (missing/invalid/anonymous bearer). */
const wsCloseUnauthorized = 4001
/** The developer has not connected GitHub — the UI should prompt `github_connect`. */
const wsCloseGithubNotConnected = 4002
/** Provisioning failed (broker/workspace misconfigured, or the broker could not mint a token). */
const wsCloseProvisionFailed = 4003

/** Per-connection state stashed on `ws.data`; Elysia's WS context doesn't surface these. */
type WsData = { request?: Request; proxy?: CodingAgentProxy; clientClosed?: boolean }
const wsData = (ws: { data: unknown }): WsData => ws.data as WsData

const safeWsClose = (ws: { close: (code?: number, reason?: string) => void }, code: number, reason: string): void => {
  try {
    ws.close(code, reason)
  } catch {
    // already closed
  }
}

export type CodingAgentDeps = {
  fetchFn?: typeof fetch
  /** Injectable upstream WS factory (tests); defaults to the global WebSocket. */
  createUpstream?: UpstreamFactory
}

/**
 * Mount the coding-agent managed-acp routes.
 *
 *  - Registers the provider into the discovery registry (idempotent on id).
 *  - Exposes `WS /v1/coding-agent/ws`: authenticate the developer, **provision
 *    their GitHub token via the broker**, then proxy ACP frames to the workspace
 *    shim. Auth + provisioning run in `open()` (Bun may call `beforeHandle` more
 *    than once per upgrade), exactly once per accepted socket, wrapped so a
 *    broker/network failure closes the socket instead of leaking an unhandled
 *    rejection (Elysia's HTTP `onError` does not cover WS lifecycle callbacks).
 *
 * Provisioning is the multi-user crux: when the broker is configured it mints a
 * user-to-server token for *this* developer (Better-Auth `user.id`) and injects
 * it into their workspace Secret before the session starts, so Cline commits as
 * them. When the broker isn't configured the proxy still runs (read-only / no-push
 * flows); a 409 closes 4002 so the UI can prompt the developer to connect GitHub.
 *
 * IMPORTANT (single-workspace caveat): today all sessions proxy to one shared
 * `CODING_AGENT_WORKSPACE_WS_URL`. Per-user workspace routing does not exist yet,
 * so concurrent users share one workspace (and the last-provisioned GH_TOKEN).
 * This is single-user / PoC-safe only — a startup WARN is emitted when both the
 * workspace and broker are configured.
 */
export const createCodingAgentRoutes = (settings: Settings, auth: Auth, deps?: CodingAgentDeps) => {
  registerAgentProvider(createCodingAgentProvider())

  const fetchFn = deps?.fetchFn ?? globalThis.fetch
  // One logger for the route's lifetime — do NOT construct per connection.
  const log = createStandaloneLogger(settings)

  const brokerConfigured = settings.codingAgentBrokerUrl.trim().length > 0
  if (settings.codingAgentWorkspaceWsUrl.trim().length > 0 && brokerConfigured) {
    log.warn(
      'coding-agent: per-user GH_TOKEN is provisioned, but all sessions proxy to a single shared ' +
        'CODING_AGENT_WORKSPACE_WS_URL. Until per-user workspace routing exists, concurrent users share one ' +
        'workspace and the last-provisioned token. Treat as single-user / PoC.',
    )
  }

  return new Elysia({ name: 'coding-agent-routes', prefix: '/coding-agent' }).onError(safeErrorHandler).ws('/ws', {
    upgrade({ request, set }) {
      const subprotocolHeader = request.headers.get('sec-websocket-protocol')
      if (subprotocolHeader?.split(',').some((entry) => entry.trim() === wsCarrierSubprotocol)) {
        set.headers['sec-websocket-protocol'] = wsCarrierSubprotocol
      }
    },
    async open(ws) {
      const data = wsData(ws)

      const subprotocolHeader = data.request?.headers.get('sec-websocket-protocol') ?? null
      const user: User | null = await authorizeWsBearer(auth, subprotocolHeader)
      if (!user) {
        safeWsClose(ws, wsCloseUnauthorized, 'unauthorized')
        return
      }

      const upstreamUrl = settings.codingAgentWorkspaceWsUrl.trim()
      if (upstreamUrl.length === 0) {
        log.warn({ userId: user.id }, 'coding-agent: workspace endpoint not configured')
        safeWsClose(ws, wsCloseProvisionFailed, 'coding agent not configured')
        return
      }

      // Provision this developer's GH_TOKEN before opening the session. Any throw
      // (network / broker down) closes the socket rather than leaking out of open().
      if (brokerConfigured) {
        let result
        try {
          result = await provisionWorkspaceToken(
            { brokerUrl: settings.codingAgentBrokerUrl, serviceToken: settings.codingAgentServiceToken, fetchFn },
            user.id,
          )
        } catch (err) {
          log.error({ userId: user.id, err }, 'coding-agent provisioning threw')
          safeWsClose(ws, wsCloseProvisionFailed, 'provisioning failed')
          return
        }
        switch (result.status) {
          case 'ok':
            log.info({ userId: user.id }, 'coding-agent provisioned')
            break
          case 'disabled':
            log.warn({ userId: user.id }, 'coding-agent broker provisioning disabled; proceeding read-only')
            break
          case 'not_connected':
            log.warn({ userId: user.id }, 'coding-agent: github not connected')
            safeWsClose(ws, wsCloseGithubNotConnected, 'github not connected')
            return
          case 'failed':
            log.error({ userId: user.id, reason: result.reason }, 'coding-agent provisioning failed')
            safeWsClose(ws, wsCloseProvisionFailed, 'provisioning failed')
            return
          default: {
            const exhaustive: never = result
            log.error({ userId: user.id, result: exhaustive }, 'coding-agent: unknown provision result')
            safeWsClose(ws, wsCloseProvisionFailed, 'provisioning failed')
            return
          }
        }
      }

      // The client may have disconnected during the awaited auth/provision above;
      // `close` would have fired before the proxy existed. Don't open the upstream.
      if (data.clientClosed) {
        log.debug({ userId: user.id }, 'coding-agent: client closed during open; aborting')
        return
      }

      try {
        data.proxy = new CodingAgentProxy({
          send: (payload) => {
            try {
              ws.send(payload)
            } catch {
              // client gone
            }
          },
          onClose: (code, reason) => safeWsClose(ws, code, reason),
          onLog: (event, detail) => log.warn({ userId: user.id, ...detail }, event),
          upstreamUrl,
        })
      } catch (err) {
        log.error({ userId: user.id, err }, 'coding-agent: upstream connect failed')
        safeWsClose(ws, wsCloseProvisionFailed, 'upstream connect failed')
        return
      }
      log.debug({ userId: user.id }, 'coding-agent ws opened')
    },
    message(ws, message) {
      const proxy = wsData(ws).proxy
      if (!proxy) {
        return
      }
      proxy.handleClientMessage(typeof message === 'string' ? message : JSON.stringify(message))
    },
    close(ws) {
      const data = wsData(ws)
      data.clientClosed = true
      data.proxy?.dispose()
      data.proxy = undefined
    },
  })
}
