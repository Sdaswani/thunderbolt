/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from 'bun:test'
import { __resetProxyFetchCacheForTests, getOrCreateProxyFetch } from './fetch'

describe('getOrCreateProxyFetch', () => {
  beforeEach(() => {
    __resetProxyFetchCacheForTests()
  })

  it('returns the same fetch reference when called with the same cloudUrl', () => {
    const first = getOrCreateProxyFetch('http://a.example/v1')
    const second = getOrCreateProxyFetch('http://a.example/v1')
    expect(second).toBe(first)
  })

  it('returns a different fetch reference when cloudUrl changes', () => {
    const first = getOrCreateProxyFetch('http://a.example/v1')
    const second = getOrCreateProxyFetch('http://b.example/v1')
    expect(second).not.toBe(first)
  })

  it('reuses the new entry for the most recent cloudUrl, evicting the previous one lazily', () => {
    const a1 = getOrCreateProxyFetch('http://a.example/v1')
    const b1 = getOrCreateProxyFetch('http://b.example/v1')
    const b2 = getOrCreateProxyFetch('http://b.example/v1')
    const a2 = getOrCreateProxyFetch('http://a.example/v1')
    expect(b2).toBe(b1)
    // Cache holds at most one entry, so re-requesting `a` after switching to `b`
    // must rebuild the fetch — verifies lazy eviction is happening.
    expect(a2).not.toBe(a1)
  })
})
