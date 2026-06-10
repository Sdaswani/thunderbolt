/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Auth-gate + provisioning close-code tests for the coding-agent WS endpoint.
 * Spins up Elysia on an ephemeral port (mirrors haystack/routes.test.ts) and
 * connects with Bun's WebSocket. The broker is stubbed via the injected `fetchFn`
 * so we can drive the provision outcome; all asserted paths close BEFORE the
 * upstream proxy is constructed (no workspace shim needed). The happy path
 * (proxy bridging) is covered by proxy.test.ts.
 *
 * Close-code contract: 4001 unauthorized, 4002 github-not-connected, 4003
 * provisioning failed / not configured.
 */

import { clearSettingsCache } from '@/config/settings'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { createTestApp } from '@/test-utils/e2e'
import { encodeWsBearer } from '@shared/ws-bearer'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'

type RunningApp = {
  listen: (port: { port: number; hostname?: string }, callback?: () => void) => unknown
  stop: (closeActiveConnections?: boolean) => Promise<void> | void
  server: { port: number } | null
}

const startApp = async (app: RunningApp): Promise<number> => {
  await new Promise<void>((resolve) => {
    app.listen({ port: 0, hostname: '127.0.0.1' }, () => resolve())
  })
  return app.server!.port
}

const stopApp = async (app: RunningApp): Promise<void> => {
  await Promise.race([Promise.resolve(app.stop(true)), new Promise((r) => setTimeout(r, 500))])
}

const observeWsTermination = (ws: WebSocket): Promise<{ code: number }> =>
  new Promise((resolve) => {
    let settled = false
    const finish = (code: number) => {
      if (!settled) {
        settled = true
        resolve({ code })
      }
    }
    ws.addEventListener('close', (event: CloseEvent) => finish(event.code))
    ws.addEventListener('error', () => finish(0))
  })

const bearerProtocols = (bearerToken: string): string[] => [
  'thunderbolt.v1',
  `thunderbolt.bearer.${encodeWsBearer(bearerToken)}`,
]

/** Stub broker: answer /github/provision with `status`; pass anything else through. */
const brokerFetch = (status: number): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/github/provision')) {
      return new Response('', { status })
    }
    return globalThis.fetch(url as string, init)
  }) as unknown as typeof fetch

describe('WS /v1/coding-agent/ws', () => {
  const cleanups: Array<() => Promise<void>> = []
  let iso: IsolatedTestDb
  const originalWs = process.env.CODING_AGENT_WORKSPACE_WS_URL
  const originalBroker = process.env.CODING_AGENT_BROKER_URL
  const originalToken = process.env.CODING_AGENT_SERVICE_TOKEN

  beforeAll(async () => {
    iso = await getSharedIsolatedTestDb()
  })

  beforeEach(() => {
    process.env.CODING_AGENT_WORKSPACE_WS_URL = 'wss://workspace.test/?token=shim'
    process.env.CODING_AGENT_BROKER_URL = 'https://broker.test'
    process.env.CODING_AGENT_SERVICE_TOKEN = 'svc-token'
    clearSettingsCache()
  })

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup()
    }
    restore('CODING_AGENT_WORKSPACE_WS_URL', originalWs)
    restore('CODING_AGENT_BROKER_URL', originalBroker)
    restore('CODING_AGENT_SERVICE_TOKEN', originalToken)
    clearSettingsCache()
  })

  const launch = async (fetchFn?: typeof fetch) => {
    const handle = await createTestApp({ database: iso.db, fetchFn })
    const port = await startApp(handle.app as unknown as RunningApp)
    cleanups.push(async () => {
      await stopApp(handle.app as unknown as RunningApp)
      await handle.cleanup()
    })
    return { port, bearerToken: handle.bearerToken }
  }

  it('closes 4001 when no bearer subprotocol is offered', async () => {
    const { port } = await launch()
    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/coding-agent/ws`, ['thunderbolt.v1'])
    expect([4001, 1006]).toContain((await observeWsTermination(client)).code)
  })

  it('closes 4001 when the bearer token is garbage', async () => {
    const { port } = await launch()
    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/coding-agent/ws`, bearerProtocols('not-a-real.token'))
    expect([4001, 1006]).toContain((await observeWsTermination(client)).code)
  })

  it('closes 4002 (github not connected) when the broker returns 409', async () => {
    const { port, bearerToken } = await launch(brokerFetch(409))
    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/coding-agent/ws`, bearerProtocols(bearerToken))
    expect([4002, 1006]).toContain((await observeWsTermination(client)).code)
  })

  it('closes 4003 (provisioning failed) when the broker returns 500', async () => {
    const { port, bearerToken } = await launch(brokerFetch(500))
    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/coding-agent/ws`, bearerProtocols(bearerToken))
    expect([4003, 1006]).toContain((await observeWsTermination(client)).code)
  })

  it('closes 4003 (not configured) when the workspace endpoint is unset', async () => {
    process.env.CODING_AGENT_WORKSPACE_WS_URL = ''
    clearSettingsCache()
    const { port, bearerToken } = await launch(brokerFetch(200))
    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/coding-agent/ws`, bearerProtocols(bearerToken))
    expect([4003, 1006]).toContain((await observeWsTermination(client)).code)
  })
})
