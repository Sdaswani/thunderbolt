/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * React context for the universal proxy fetch.
 *
 * The provider builds one `proxyFetch` per `cloudUrl` and memoizes it. Consumers
 * call `useFetch()` from any component or hook to get a `fetch`-shaped function
 * that hides Hosted (web) vs Standalone (Tauri) mode — see `proxy-fetch.ts`.
 *
 * Non-React callers (e.g. `src/ai/fetch.ts`) cannot use this hook directly; they
 * should construct or cache their own `proxyFetch` via `createProxyFetch`.
 */

import { defaultSettingCloudUrl } from '@/defaults/settings'
import { useSettings } from '@/hooks/use-settings'
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { createProxyFetch } from './proxy-fetch'

type ProxyFetchContextValue = {
  proxyFetch: typeof fetch
}

const ProxyFetchContext = createContext<ProxyFetchContextValue | undefined>(undefined)

type ProxyFetchProviderProps = {
  children: ReactNode
  /** Override the proxy fetch in tests so callers don't need a real backend. */
  proxyFetch?: typeof fetch
}

/**
 * Mounts a memoized `proxyFetch` for the current `cloudUrl` setting. The fetch
 * is re-created only when `cloudUrl` changes (`useMemo`, no `useEffect` — this
 * is derived state, see CLAUDE.md `useEffect` discipline).
 */
export const ProxyFetchProvider = ({ children, proxyFetch: override }: ProxyFetchProviderProps) => {
  const { cloudUrl } = useSettings({ cloud_url: defaultSettingCloudUrl.value ?? 'http://localhost:8000/v1' })
  const resolvedCloudUrl = cloudUrl.value ?? defaultSettingCloudUrl.value ?? 'http://localhost:8000/v1'

  const proxyFetch = useMemo(() => {
    return override ?? createProxyFetch({ cloudUrl: resolvedCloudUrl })
  }, [override, resolvedCloudUrl])

  return <ProxyFetchContext.Provider value={{ proxyFetch }}>{children}</ProxyFetchContext.Provider>
}

/** Returns the proxy fetch for the current cloudUrl. Throws if used outside the provider. */
export const useFetch = (): typeof fetch => {
  const context = useContext(ProxyFetchContext)
  if (!context) {
    throw new Error('useFetch must be used within a ProxyFetchProvider')
  }
  return context.proxyFetch
}
