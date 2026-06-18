/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HaystackReferenceMeta } from '@/types'
import { type DocumentCitationSource, isDocumentCitation } from '@/types/citation'
import { describe, expect, test } from 'bun:test'
import { buildMessageCitations, haystackRefToSource } from './citation-utils'

const ref = (position: number, overrides: Partial<HaystackReferenceMeta> = {}): HaystackReferenceMeta => ({
  position,
  fileId: `file-${position}`,
  fileName: `doc-${position}.txt`,
  ...overrides,
})

describe('haystackRefToSource', () => {
  test('maps chapter/book/url and carries documentMeta', () => {
    const source = haystackRefToSource(
      ref(1, {
        title: 'The Sky Above',
        bookTitle: 'Astronomy',
        sourceUrl: 'https://openstax.org/2-1',
        pageNumber: 1,
        contributors: 'Aruna Nair',
        score: 0.95,
      }),
      true,
    )

    expect(isDocumentCitation(source)).toBe(true)
    expect(source.title).toBe('The Sky Above')
    expect(source.siteName).toBe('Astronomy')
    expect(source.url).toBe('https://openstax.org/2-1')
    expect(source.isPrimary).toBe(true)
    expect(source.documentMeta.pageNumber).toBe(1)
    expect(source.documentMeta.contributors).toBe('Aruna Nair')
    expect(source.documentMeta.score).toBe(0.95)
  })

  test('falls back to filename + extension when meta absent', () => {
    const source = haystackRefToSource(ref(1), false)

    expect(source.title).toBe('doc-1.txt')
    expect(source.siteName).toBe('TXT')
    expect(source.url).toBe('')
    expect(source.isPrimary).toBe(false)
  })
})

describe('buildMessageCitations', () => {
  test('dedupes by document and orders by first position', () => {
    const refs = [ref(3, { fileId: 'b' }), ref(1, { fileId: 'a' }), ref(6, { fileId: 'b' }), ref(2, { fileId: 'c' })]
    const sources = buildMessageCitations(refs)

    expect(sources.map((s) => (s as DocumentCitationSource).documentMeta.fileId)).toEqual(['a', 'c', 'b'])
    expect(sources[0].isPrimary).toBe(true)
    expect(sources[1].isPrimary).toBe(false)
  })

  test('returns empty for no references', () => {
    expect(buildMessageCitations([])).toEqual([])
  })
})
