/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { type ReactNode } from 'react'
import { ProxyFetchProvider, useFetch } from './proxy-fetch-context'

describe('useFetch + ProxyFetchProvider', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    await resetTestDatabase()
  })

  it('returns the override fetch when one is supplied to the provider', () => {
    const fakeFetch = mock(async () => new Response('ok')) as unknown as typeof fetch
    const TestProvider = createTestProvider()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TestProvider>
        <ProxyFetchProvider proxyFetch={fakeFetch}>{children}</ProxyFetchProvider>
      </TestProvider>
    )

    const { result } = renderHook(() => useFetch(), { wrapper })

    expect(result.current).toBe(fakeFetch)
  })

  it('returns a stable fetch reference across re-renders when cloudUrl is unchanged', () => {
    const fakeFetch = mock(async () => new Response('ok')) as unknown as typeof fetch
    const TestProvider = createTestProvider()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TestProvider>
        <ProxyFetchProvider proxyFetch={fakeFetch}>{children}</ProxyFetchProvider>
      </TestProvider>
    )

    const { result, rerender } = renderHook(() => useFetch(), { wrapper })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('builds a real proxyFetch when no override is given and `cloud_url` falls back to the default', () => {
    const TestProvider = createTestProvider()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TestProvider>
        <ProxyFetchProvider>{children}</ProxyFetchProvider>
      </TestProvider>
    )

    const { result } = renderHook(() => useFetch(), { wrapper })

    expect(typeof result.current).toBe('function')
  })

  it('throws a clear error when used outside of ProxyFetchProvider', () => {
    // Suppress React's noisy "uncaught error" log for this expected throw.
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => renderHook(() => useFetch())).toThrow('useFetch must be used within a ProxyFetchProvider')
    } finally {
      consoleSpy.mockRestore()
    }
  })
})
