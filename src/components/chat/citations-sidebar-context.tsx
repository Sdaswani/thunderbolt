/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DocumentCitationSource } from '@/types/citation'
import { createContext, useContext, type ReactNode } from 'react'

/** The citations currently shown in the sidebar, scoped to one message. */
export type CitationsSidebarData = {
  /** Message whose citations are shown — lets callers swap/replace by message. */
  messageId: string
  sources: DocumentCitationSource[]
  /** `fileId` of the row to highlight (e.g. the inline marker that was clicked). */
  highlightId?: string
}

export type CitationsSidebarActions = {
  open: (data: CitationsSidebarData) => void
  close: () => void
}

/**
 * Sidebar actions only (stable). The active state is passed to the panel as a
 * prop, so toggling the sidebar never re-renders consumers of this context.
 * Lives in a leaf module (no component imports) to keep the inline citation
 * badge — which opens the sidebar — out of an import cycle.
 */
export const CitationsSidebarContext = createContext<CitationsSidebarActions | null>(null)

/** Access the citations sidebar. Returns null outside a provider so optional callers can no-op. */
export const useCitationsSidebar = () => useContext(CitationsSidebarContext)

/**
 * The message an inline citation badge belongs to, plus that message's full
 * (deduped) citation set. Lets a badge open the sidebar to the whole message —
 * matching auto-open — while highlighting the clicked source.
 */
export type CitationMessageValue = {
  messageId: string
  sources: DocumentCitationSource[]
}

export const CitationMessageContext = createContext<CitationMessageValue | null>(null)

/** Access the inline citation badge's owning message + its citation set, or null. */
export const useCitationMessage = () => useContext(CitationMessageContext)

export const CitationMessageProvider = ({
  value,
  children,
}: {
  value: CitationMessageValue | null
  children: ReactNode
}) => <CitationMessageContext.Provider value={value}>{children}</CitationMessageContext.Provider>
