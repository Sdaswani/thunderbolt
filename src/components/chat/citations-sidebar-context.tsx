/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DocumentCitationSource } from '@/types/citation'
import { createContext, useContext, type ReactNode } from 'react'

/**
 * The message an inline citation badge belongs to, plus that message's full
 * (deduped) citation set. Lets a badge open the content view to the whole
 * message — matching the footer button — while highlighting the clicked source.
 *
 * Lives in a leaf module (no component imports) to keep the inline citation
 * badge out of an import cycle with the panel.
 */
export type CitationMessageValue = {
  messageId: string
  sources: DocumentCitationSource[]
}

const CitationMessageContext = createContext<CitationMessageValue | null>(null)

/** Access the inline citation badge's owning message + its citation set, or null. */
export const useCitationMessage = () => useContext(CitationMessageContext)

export const CitationMessageProvider = ({
  value,
  children,
}: {
  value: CitationMessageValue | null
  children: ReactNode
}) => <CitationMessageContext.Provider value={value}>{children}</CitationMessageContext.Provider>
