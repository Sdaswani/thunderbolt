/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { ContentViewProvider, useContentView } from '@/content-view/context'
import type { DocumentCitationSource } from '@/types/citation'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { CitationsPanel, CitationsSidebarButton } from './citations-sidebar'
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

const StateProbe = () => {
  const { state } = useContentView()
  return <div data-testid="state">{state.type ?? 'none'}</div>
}

describe('CitationsPanel', () => {
  it('renders the message sources with numbers and a count header', () => {
    const onClose = mock(() => {})
    render(
      <ContentViewProvider>
        <ExternalLinkDialogProvider>
          <CitationsPanel data={{ messageId: 'm1', sources }} onClose={onClose} />
        </ExternalLinkDialogProvider>
      </ContentViewProvider>,
    )

    expect(screen.getByText('The Sky Above')).toBeInTheDocument()
    expect(screen.getByText('Gravitation')).toBeInTheDocument()
    expect(screen.getByText('1.')).toBeInTheDocument()
    expect(screen.getByText(/Sources \(2\)/)).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Close sources'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('CitationsSidebarButton', () => {
  it('opens the content view to the citations panel on click', () => {
    render(
      <ContentViewProvider>
        <ExternalLinkDialogProvider>
          <StateProbe />
          <CitationsSidebarButton messageId="m1" sources={sources} />
        </ExternalLinkDialogProvider>
      </ContentViewProvider>,
    )

    expect(screen.getByTestId('state').textContent).toBe('none')
    fireEvent.click(screen.getByLabelText('Show sources'))
    expect(screen.getByTestId('state').textContent).toBe('citations')
  })

  it('renders nothing with no sources', () => {
    render(
      <ContentViewProvider>
        <CitationsSidebarButton messageId="m1" sources={[]} />
      </ContentViewProvider>,
    )
    expect(screen.queryByLabelText('Show sources')).toBeNull()
  })

  it('renders nothing outside a content view provider', () => {
    render(<CitationsSidebarButton messageId="m1" sources={sources} />)
    expect(screen.queryByLabelText('Show sources')).toBeNull()
  })
})
