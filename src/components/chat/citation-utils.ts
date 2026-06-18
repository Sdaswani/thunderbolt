/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HaystackReferenceMeta } from '@/types'
import { buildDocumentSideviewId, type DocumentCitationSource } from '@/types/citation'

/**
 * Map a single Haystack reference to a document-backed citation source.
 *
 * Shared by the inline citation badges and the citations sidebar so the two
 * never drift: `title` is the chapter/section, `siteName` is the book (falling
 * back to the file extension), `url` is the canonical source link, and
 * `documentMeta` carries the ids used for the in-app viewer fallback.
 */
export const haystackRefToSource = (ref: HaystackReferenceMeta, isPrimary: boolean): DocumentCitationSource => {
  const ext = ref.fileName.split('.').pop()?.toLowerCase() ?? ''
  return {
    id: buildDocumentSideviewId(ref),
    title: ref.title || ref.fileName,
    url: ref.sourceUrl ?? '',
    siteName: ref.bookTitle || ext.toUpperCase(),
    isPrimary,
    documentMeta: {
      fileId: ref.fileId,
      fileName: ref.fileName,
      pageNumber: ref.pageNumber,
      contributors: ref.contributors,
      score: ref.score,
    },
  }
}

/**
 * Build the deduped, ordered citation list for a message's sidebar.
 *
 * A message commonly cites the same document at several `[N]` positions, so we
 * collapse to one row per unique document (keyed by `fileId`), keeping the
 * order of first appearance. The first row is flagged `isPrimary`.
 */
export const buildMessageCitations = (references: HaystackReferenceMeta[]): DocumentCitationSource[] => {
  const seen = new Set<string>()
  const sources: DocumentCitationSource[] = []
  for (const ref of [...references].sort((a, b) => a.position - b.position)) {
    if (seen.has(ref.fileId)) {
      continue
    }
    seen.add(ref.fileId)
    sources.push(haystackRefToSource(ref, sources.length === 0))
  }
  return sources
}
