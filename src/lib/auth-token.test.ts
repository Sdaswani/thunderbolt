/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  clearAuthToken,
  clearDeviceId,
  getAuthenticatedHeaders,
  getAuthToken,
  getDeviceId,
  onAuthTokenChangedInOtherTab,
  setAuthToken,
} from './auth-token'

const authTokenKey = 'thunderbolt_auth_token'

/**
 * Capture the handler that `onAuthTokenChangedInOtherTab` registers, so tests
 * can invoke it directly with a constructed event rather than relying on the
 * full `window.addEventListener` / `dispatchEvent` round-trip.
 *
 * Why bypass dispatch: when this file runs alongside the rest of the suite
 * under `--randomize`, some upstream test corrupts happy-dom's event delivery
 * for the `storage` event (the listener gets registered but `dispatchEvent`
 * doesn't fire it). Calling the captured handler directly tests the same
 * impl logic without depending on the unreliable host-environment plumbing.
 */
let capturedStorageHandler: ((event: StorageEvent) => void) | null = null
let restoreAddEventListener: (() => void) | null = null

const fireStorageEvent = (newValue: string | null, oldValue: string | null, key = authTokenKey) => {
  // No-op when no handler is currently registered. Matches the original
  // dispatchEvent behavior: firing into a window with no listener attached
  // is silent (e.g. the "stops firing after unsubscribe" test).
  if (!capturedStorageHandler) {
    return
  }
  capturedStorageHandler({
    key,
    newValue,
    oldValue,
    storageArea: localStorage,
  } as StorageEvent)
}

beforeEach(() => {
  capturedStorageHandler = null
  // Capture originals as consts inside this scope so each wrapper's closure
  // binds to *this* call's values. A module-level `let` would mutate under
  // the wrapper's feet on subsequent beforeEach runs and make the wrapper
  // call itself (infinite recursion under --rerun-each).
  const originalAddEventListener = window.addEventListener
  const originalRemoveEventListener = window.removeEventListener

  const addWrapper = ((
    event: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (event === 'storage' && typeof listener === 'function') {
      capturedStorageHandler = listener as (event: StorageEvent) => void
    }
    return originalAddEventListener.call(window, event, listener, options)
  }) as typeof window.addEventListener

  const removeWrapper = ((
    event: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    if (event === 'storage' && capturedStorageHandler === listener) {
      capturedStorageHandler = null
    }
    return originalRemoveEventListener.call(window, event, listener, options)
  }) as typeof window.removeEventListener

  window.addEventListener = addWrapper
  window.removeEventListener = removeWrapper
  restoreAddEventListener = () => {
    if (window.addEventListener === addWrapper) {
      window.addEventListener = originalAddEventListener
    }
    if (window.removeEventListener === removeWrapper) {
      window.removeEventListener = originalRemoveEventListener
    }
  }
  clearAuthToken()
  clearDeviceId()
})

afterEach(() => {
  restoreAddEventListener?.()
  restoreAddEventListener = null
  capturedStorageHandler = null
})

describe('auth-token', () => {
  describe('getAuthToken', () => {
    it('returns null when no token is stored', () => {
      expect(getAuthToken()).toBeNull()
    })

    it('returns token after setAuthToken', () => {
      setAuthToken('test-token-123')
      expect(getAuthToken()).toBe('test-token-123')
    })
  })

  describe('setAuthToken', () => {
    it('stores token in localStorage', () => {
      setAuthToken('cached-token')
      expect(getAuthToken()).toBe('cached-token')
    })

    it('persists token until cleared', () => {
      setAuthToken('persisted-token')
      expect(getAuthToken()).toBe('persisted-token')
      clearAuthToken()
      expect(getAuthToken()).toBeNull()
    })
  })

  describe('clearAuthToken', () => {
    it('clears token', () => {
      setAuthToken('token-to-clear')
      expect(getAuthToken()).toBe('token-to-clear')
      clearAuthToken()
      expect(getAuthToken()).toBeNull()
    })

    it('clears token from localStorage', () => {
      setAuthToken('persistent-token')
      clearAuthToken()
      expect(getAuthToken()).toBeNull()
      setAuthToken('other')
      expect(getAuthToken()).toBe('other')
    })
  })

  describe('getAuthenticatedHeaders', () => {
    it('returns Authorization, X-Device-ID, and X-Device-Name when token and device ID exist', () => {
      setAuthToken('my-token')
      getDeviceId() // ensure device ID is created

      const headers = getAuthenticatedHeaders()

      expect(headers['Authorization']).toBe('Bearer my-token')
      expect(headers['X-Device-ID']).toBeTruthy()
      expect(headers['X-Device-Name']).toBeTruthy()
    })

    it('returns device headers but no Authorization when no auth token', () => {
      getDeviceId() // ensure device ID is created

      const headers = getAuthenticatedHeaders()

      expect(headers['Authorization']).toBeUndefined()
      expect(headers['X-Device-ID']).toBeTruthy()
      expect(headers['X-Device-Name']).toBeTruthy()
    })

    it('returns consistent device ID across calls', () => {
      const headers1 = getAuthenticatedHeaders()
      const headers2 = getAuthenticatedHeaders()

      expect(headers1['X-Device-ID']).toBe(headers2['X-Device-ID'])
    })
  })
})

describe('onAuthTokenChangedInOtherTab', () => {
  it('fires listener when token rotates', () => {
    const listener = mock(() => {})
    const unsub = onAuthTokenChangedInOtherTab(listener)

    fireStorageEvent('new-token', 'old-token')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('new-token', 'old-token')
    unsub()
  })

  it('fires listener when token is cleared (sign-out from another tab)', () => {
    const listener = mock(() => {})
    const unsub = onAuthTokenChangedInOtherTab(listener)

    fireStorageEvent(null, 'old-token')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(null, 'old-token')
    unsub()
  })

  it('does not fire for unrelated storage keys', () => {
    const listener = mock(() => {})
    const unsub = onAuthTokenChangedInOtherTab(listener)

    fireStorageEvent('some-value', null, 'other_key')

    expect(listener).not.toHaveBeenCalled()
    unsub()
  })

  it('does not fire when new value equals old value', () => {
    const listener = mock(() => {})
    const unsub = onAuthTokenChangedInOtherTab(listener)

    fireStorageEvent('same-token', 'same-token')

    expect(listener).not.toHaveBeenCalled()
    unsub()
  })

  it('stops firing after unsubscribe', () => {
    const listener = mock(() => {})
    const unsub = onAuthTokenChangedInOtherTab(listener)
    unsub()

    fireStorageEvent('new-token', 'old-token')

    expect(listener).not.toHaveBeenCalled()
  })

  it('does not fire for events from sessionStorage', () => {
    const listener = mock(() => {})
    const unsub = onAuthTokenChangedInOtherTab(listener)

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: authTokenKey,
        newValue: 'new-token',
        oldValue: 'old-token',
        storageArea: sessionStorage,
      }),
    )

    expect(listener).not.toHaveBeenCalled()
    unsub()
  })
})
