/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { type CitationsViewData, useShowCitations } from '@/content-view/context'
import { useIsMobile } from '@/hooks/use-mobile'
import type { DocumentCitationSource } from '@/types/citation'
import { Quote, X } from 'lucide-react'
import { memo } from 'react'
import { CitationRow } from './citation-row'

/**
 * Footer affordance (sibling to the copy button) that opens the citations panel
 * in the content view, scoped to a given message. Renders nothing when there
 * are no citations or no content view provider in scope.
 */
export const CitationsSidebarButton = ({
  messageId,
  sources,
}: {
  messageId: string
  sources: DocumentCitationSource[]
}) => {
  const showCitations = useShowCitations()
  if (!showCitations || sources.length === 0) {
    return null
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 rounded-lg"
      title="Show sources"
      aria-label="Show sources"
      onClick={() => showCitations({ messageId, sources })}
    >
      <Quote className="size-4 text-muted-foreground/80" />
    </Button>
  )
}

/**
 * Citations content for the content view's right panel: a header and the
 * message's deduped source rows. The panel container (resize, width
 * persistence, mobile full-width) is owned by the content view in
 * `main-layout.tsx` — this just fills it, matching the document viewer.
 */
export const CitationsPanel = memo(({ data, onClose }: { data: CitationsViewData; onClose: () => void }) => {
  const { isMobile } = useIsMobile()
  const sources = data.sources
  const title = sources.length === 1 ? 'Source' : 'Sources'

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-[length:var(--font-size-body)] font-medium">
          {title}
          {sources.length > 0 ? ` (${sources.length})` : ''}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close sources"
          className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-[var(--icon-size-sm)]" />
        </button>
      </div>
      <div className="flex flex-col gap-1 overflow-y-auto p-2" role="list">
        {sources.map((source, index) => (
          <CitationRow
            key={source.id}
            index={index + 1}
            source={source}
            highlighted={source.documentMeta.fileId === data.highlightId}
            onSelect={isMobile ? onClose : undefined}
          />
        ))}
      </div>
    </div>
  )
})

CitationsPanel.displayName = 'CitationsPanel'
