/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isLoopbackHost } from './is-loopback'

describe('isLoopbackHost', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'sub.localhost', 'app.dev.localhost'])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true)
    },
  )

  it.each([
    'example.com',
    '192.0.2.1',
    'wss-public.example.org',
    '10.0.0.1',
    'localhost.example.com',
    '::2',
    '128.0.0.1',
  ])('treats %s as non-loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(false)
  })
})
