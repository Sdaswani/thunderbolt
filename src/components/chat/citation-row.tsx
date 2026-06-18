/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useOpenExternalLink } from '@/components/chat/markdown-utils'
import { useContentView } from '@/content-view/context'
import { isSafeUrl } from '@/lib/url-utils'
import { cn } from '@/lib/utils'
import { buildDocumentSideviewId, type DocumentCitationSource } from '@/types/citation'

type CitationRowProps = {
  source: DocumentCitationSource
  /** 1-based position shown as a leading "N." (matches the numbered sources list). */
  index?: number
  /** Highlight this row — e.g. when the sidebar was opened from its inline marker. */
  highlighted?: boolean
  /** Called after the row's action fires (open source link / fallback viewer). */
  onSelect?: () => void
}

/** Ascending heights for the 3 relevance bars (signal-strength style). */
const barHeights = ['h-2', 'h-3', 'h-4']

/** Renders 3 bars filled in proportion to a 0–1 relevance score. */
const RelevanceBars = ({ score }: { score: number }) => {
  const filled = score >= 0.66 ? 3 : score >= 0.33 ? 2 : 1
  return (
    <span className="flex items-end gap-0.5" aria-label={`Relevance: ${filled} of 3`}>
      {barHeights.map((height, i) => (
        <span key={i} className={cn('w-1 rounded-sm', height, i < filled ? 'bg-primary' : 'bg-muted')} />
      ))}
    </span>
  )
}

/**
 * A single citation in the citations sidebar: an optional number, the title as
 * a link, a "(p. N)" indicator and relevance bars top-right, and an
 * "<author>, in <source>" subtitle. Clicking opens the citation's canonical
 * source URL when present, falling back to the in-app document viewer.
 */
export const CitationRow = ({ source, index, highlighted, onSelect }: CitationRowProps) => {
  const openExternalLink = useOpenExternalLink()
  const { showSideview } = useContentView()

  const hasSourceUrl = isSafeUrl(source.url)
  const { pageNumber, contributors, score } = source.documentMeta
  const book = source.siteName || 'Source'
  const subtitle = contributors ? `${contributors}, in ${book}` : book

  const handleClick = () => {
    if (hasSourceUrl) {
      openExternalLink(source.url)
    } else {
      showSideview('document', buildDocumentSideviewId(source.documentMeta))
    }
    onSelect?.()
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'group flex w-full cursor-pointer gap-2.5 rounded-lg px-4 py-3 text-left transition-colors hover:bg-accent/50',
        highlighted && 'bg-accent ring-1 ring-ring',
      )}
      role="listitem"
    >
      {index != null && (
        <span className="shrink-0 text-[length:var(--font-size-body)] leading-6 tabular-nums text-muted-foreground">
          {index}.
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-start justify-between gap-2">
          <span className="text-[length:var(--font-size-body)] font-medium leading-6 text-primary group-hover:underline">
            {source.title || book}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
            {pageNumber != null && (
              <span className="text-[length:var(--font-size-xs)] leading-4 text-muted-foreground">
                (p. {pageNumber})
              </span>
            )}
            {score != null && <RelevanceBars score={score} />}
          </span>
        </span>
        <span className="text-[length:var(--font-size-xs)] leading-4 text-muted-foreground">{subtitle}</span>
      </span>
    </button>
  )
}
