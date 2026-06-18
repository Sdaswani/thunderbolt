/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { ContentViewProvider } from '@/content-view/context'
import type { DocumentCitationSource } from '@/types/citation'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { CitationsSidebarProvider } from './citations-sidebar'
import { useCitationsSidebar } from './citations-sidebar-context'
import { ExternalLinkDialogProvider } from './markdown-utils'

const sources: DocumentCitationSource[] = [
  {
    id: 'file-1:a.txt:1',
    title: 'The Sky Above',
    url: 'https://openstax.org/books/astronomy/pages/2-1',
    siteName: 'Astronomy',
    isPrimary: true,
    documentMeta: { fileId: 'file-1', fileName: 'a.txt', pageNumber: 1 },
  },
  {
    id: 'file-2:b.txt:5',
    title: 'Gravitation',
    url: 'https://openstax.org/books/astronomy/pages/3-3',
    siteName: 'Astronomy',
    documentMeta: { fileId: 'file-2', fileName: 'b.txt', pageNumber: 5 },
  },
]

const Harness = () => {
  const ctx = useCitationsSidebar()!
  return (
    <>
      <button onClick={() => ctx.open({ messageId: 'm1', sources })}>open</button>
      <button onClick={ctx.close}>close</button>
    </>
  )
}

const renderSidebar = () =>
  render(
    <ContentViewProvider>
      <ExternalLinkDialogProvider>
        <CitationsSidebarProvider>
          <Harness />
        </CitationsSidebarProvider>
      </ExternalLinkDialogProvider>
    </ContentViewProvider>,
  )

describe('CitationsSidebar', () => {
  it('is closed initially, opens with the message citations, then closes', () => {
    renderSidebar()
    expect(screen.queryByText('The Sky Above')).toBeNull()

    fireEvent.click(screen.getByText('open'))
    expect(screen.getByText('The Sky Above')).toBeInTheDocument()
    expect(screen.getByText('Gravitation')).toBeInTheDocument()
    expect(screen.getByText('1.')).toBeInTheDocument()

    fireEvent.click(screen.getByText('close'))
    expect(screen.queryByText('The Sky Above')).toBeNull()
  })
})
