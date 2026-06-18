/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import type { DocumentCitationSource } from '@/types/citation'
import { Quote, X } from 'lucide-react'
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import { CitationRow } from './citation-row'
import { CitationsSidebarContext, type CitationsSidebarData, useCitationsSidebar } from './citations-sidebar-context'

/**
 * Owns the citations sidebar state and renders the panel (desktop right
 * slide-over) / sheet (mobile bottom). The active set is scoped to a single
 * message so callers can auto-open the latest answer, swap on a new one, or
 * re-open an older message from its quote button / inline markers.
 */
export const CitationsSidebarProvider = ({ children }: { children: ReactNode }) => {
  const [active, setActive] = useState<CitationsSidebarData | null>(null)
  const open = useCallback((data: CitationsSidebarData) => setActive(data), [])
  const close = useCallback(() => setActive(null), [])
  // Value carries only the stable actions — `active` is passed to the panel
  // directly as a prop, so toggling the sidebar never re-renders consumers.
  const value = useMemo(() => ({ open, close }), [open, close])

  return (
    <CitationsSidebarContext.Provider value={value}>
      {children}
      <CitationsSidebarPanel active={active} close={close} />
    </CitationsSidebarContext.Provider>
  )
}

/**
 * Footer affordance (sibling to the copy button) that re-opens the citations
 * sidebar scoped to a given message. Renders nothing when there are no
 * citations or no sidebar provider in scope.
 */
export const CitationsSidebarButton = ({
  messageId,
  sources,
}: {
  messageId: string
  sources: DocumentCitationSource[]
}) => {
  const sidebar = useCitationsSidebar()
  if (!sidebar || sources.length === 0) {
    return null
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 rounded-lg"
      title="Show sources"
      aria-label="Show sources"
      onClick={() => sidebar.open({ messageId, sources })}
    >
      <Quote className="size-4 text-muted-foreground/80" />
    </Button>
  )
}

const CitationsSidebarPanel = memo(({ active, close }: { active: CitationsSidebarData | null; close: () => void }) => {
  const { isMobile } = useIsMobile()
  const isOpen = active !== null
  const sources = active?.sources ?? []
  const title = sources.length === 1 ? 'Source' : 'Sources'

  const list = (
    <div className="flex flex-col gap-1 overflow-y-auto p-2" role="list">
      {sources.map((source, index) => (
        <CitationRow
          key={source.id}
          index={index + 1}
          source={source}
          highlighted={source.documentMeta.fileId === active?.highlightId}
          onSelect={isMobile ? close : undefined}
        />
      ))}
    </div>
  )

  if (isMobile) {
    return (
      <Sheet open={isOpen} onOpenChange={(o) => !o && close()}>
        <SheetContent
          side="bottom"
          className="inset-x-1 flex max-h-[70vh] flex-col overflow-hidden rounded-2xl border p-0"
          style={{ bottom: 'calc(20px + var(--safe-area-bottom-padding, 0px))' }}
        >
          <SheetHeader className="px-4 pt-4">
            <SheetTitle>{title}</SheetTitle>
          </SheetHeader>
          {list}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <div
      className={cn(
        'fixed right-0 top-0 z-40 flex h-full w-[360px] max-w-full flex-col border-l bg-background transition-transform duration-300 ease-out',
        isOpen ? 'translate-x-0' : 'translate-x-full',
      )}
      aria-hidden={!isOpen}
    >
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-[length:var(--font-size-body)] font-medium">
          {title}
          {sources.length > 0 ? ` (${sources.length})` : ''}
        </h2>
        <button
          type="button"
          onClick={close}
          aria-label="Close sources"
          className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-[var(--icon-size-sm)]" />
        </button>
      </div>
      {list}
    </div>
  )
})

CitationsSidebarPanel.displayName = 'CitationsSidebarPanel'
