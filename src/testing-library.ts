/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearMemoizeCache } from '@/lib/memoize'
import { installFakeTimers } from '@/test-utils/fake-timers'
import type { Clock } from '@sinonjs/fake-timers'
import * as matchers from '@testing-library/jest-dom/matchers'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, beforeEach, expect, mock } from 'bun:test'

// Mock web-haptics/react globally — no vibration API in test environment
mock.module('web-haptics/react', () => ({
  useWebHaptics: () => ({ trigger: () => {} }),
}))

// Mock useHaptics globally — the real provider depends on useSettings (QueryClient) and web-haptics
mock.module('@/hooks/use-haptics', () => ({
  useHaptics: () => ({
    triggerSelection: () => {},
    triggerImpact: () => {},
    triggerNotification: () => {},
  }),
  HapticsProvider: ({ children }: { children: unknown }) => children,
}))

// Mock posthog-js globally to prevent browser detection errors in tests
// PostHog tries to access browser APIs like navigator.userAgent.match() during module load,
// which fails in Happy-DOM's test environment
mock.module('posthog-js', () => ({
  default: {
    init: () => null,
    capture: () => {},
    identify: () => {},
    reset: () => {},
    opt_out_capturing: () => {},
    opt_in_capturing: () => {},
    has_opted_out_capturing: () => false,
    get_distinct_id: () => 'test-distinct-id',
    captureException: () => {},
  },
}))

expect.extend(matchers)

// CRITICAL FIX: Configure @testing-library to not use fake timers
// This prevents @testing-library from trying to call jest.advanceTimersByTime
// which doesn't work reliably in CI
configure({
  // Custom async wrapper that doesn't try to use fake timers
  asyncWrapper: async (cb) => await cb(),
})

// Suppress console output during tests to reduce noise
// These are typically expected from testing or normal operations
const originalConsoleError = console.error
const originalConsoleWarn = console.warn
const originalConsoleInfo = console.info

// Suppress console methods globally (but not console.log for debugging)
console.error = () => {}
console.warn = () => {}
console.info = () => {}

/**
 * Restore the original console functions.
 * Use this in tests where you need to verify console output or debug issues.
 *
 * @example
 * import { restoreConsole } from '@/testing-library'
 *
 * test('should log error', () => {
 *   restoreConsole()
 *   // ... test that expects console.error to be called
 * })
 */
export const restoreConsole = () => {
  console.error = originalConsoleError
  console.warn = originalConsoleWarn
  console.info = originalConsoleInfo
}

/**
 * Suppress console output.
 * This is automatically called in beforeEach, but can be used manually
 * if you restored console during a test and want to suppress it again.
 */
export const suppressConsole = () => {
  console.error = () => {}
  console.warn = () => {}
  console.info = () => {}
}

// Global fake timers setup - we manage our own
let globalClock: Clock | null = null

// Mock jest global for @testing-library/dom's waitFor which tries to use jest.advanceTimersByTime
// This must be defined after globalClock so it can access it
const existingJest = (globalThis as any).jest || {}
;(globalThis as any).jest = {
  ...existingJest,
  advanceTimersByTime: (ms: number) => {
    if (globalClock) {
      globalClock.tick(ms)
    }
  },
}

beforeEach(() => {
  // Defensive: if a prior test's afterEach didn't run to completion (e.g. its
  // own async afterEach hung or threw), fake timers can be left installed.
  // sinon's install() throws on re-install — catch and reset cleanly so we
  // don't cascade a single bad teardown into every subsequent test failing.
  try {
    globalClock = installFakeTimers()
  } catch {
    // Already installed from prior leakage. Best effort: keep going without
    // a fresh clock; tests using getClock() will surface the issue locally.
    globalClock = null
  }
  // Ensure console is suppressed for each test
  suppressConsole()
  // Clear memoized values to prevent pollution between tests
  clearMemoizeCache()
})

afterEach(() => {
  if (globalClock) {
    // Defensive — guard each step so one failure doesn't skip later cleanup.
    try {
      globalClock.reset()
    } catch {
      /* clock state was corrupted; uninstall anyway */
    }
    try {
      globalClock.uninstall()
    } catch {
      /* uninstall failed (e.g. already uninstalled); fall through */
    }
  }
  // ALWAYS null the reference, even if the above threw, so the next test's
  // beforeEach gets a clean slate.
  globalClock = null
  cleanup()
})

/**
 * Opt out of the global fake-timer setup for a test (or test file) that
 * genuinely needs real timers — e.g. tests that spawn Web Workers and wait
 * for postMessage scheduling, which happy-dom routes through real setTimeout.
 *
 * Call from `beforeEach`. The global `afterEach` will be a no-op for clock
 * state (already nulled), so no further cleanup is needed.
 */
export const useRealTimers = (): void => {
  if (globalClock) {
    try {
      globalClock.reset()
    } catch {
      // ignore
    }
    try {
      globalClock.uninstall()
    } catch {
      // ignore
    }
    globalClock = null
  }
}

/**
 * Get the current global fake clock instance for the test.
 * Use this when you need to manually advance time in tests.
 *
 * @example
 * await act(async () => {
 *   await getClock().runAllAsync()
 * })
 */
export const getClock = (): Clock => {
  if (!globalClock) {
    throw new Error('Clock is not installed. This should not happen in tests.')
  }
  return globalClock
}
