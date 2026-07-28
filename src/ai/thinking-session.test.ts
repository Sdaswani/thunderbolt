/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isThinkingDisabledForSend } from './thinking-session'

describe('isThinkingDisabledForSend', () => {
  it('is true only for thinking-capable models with the chip off', () => {
    expect(isThinkingDisabledForSend({ startWithReasoning: 1 }, false)).toBe(true)
    expect(isThinkingDisabledForSend({ startWithReasoning: 1 }, true)).toBe(false)
    expect(isThinkingDisabledForSend({ startWithReasoning: 1 }, undefined)).toBe(false)
    expect(isThinkingDisabledForSend({ startWithReasoning: 0 }, false)).toBe(false)
  })
})
