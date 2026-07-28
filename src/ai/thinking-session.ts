/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Model } from '@/types'

/**
 * True when the selected model advertises thinking and the conversation chip
 * has turned it off for this send.
 */
export const isThinkingDisabledForSend = (
  model: Pick<Model, 'startWithReasoning'>,
  thinkingEnabled: boolean | undefined,
): boolean => model.startWithReasoning === 1 && thinkingEnabled === false
