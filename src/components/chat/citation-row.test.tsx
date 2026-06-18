/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { ContentViewProvider, useContentView } from '@/content-view/context'
import type { DocumentCitationSource } from '@/types/citation'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { type ReactElement, type ReactNode } from 'react'
import { CitationRow } from './citation-row'
import { ExternalLinkDialogProvider } from './markdown-utils'

const renderWithProvider = (ui: ReactElement) =>
  render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ContentViewProvider>
        <ExternalLinkDialogProvider>{children}</ExternalLinkDialogProvider>
      </ContentViewProvider>
    ),
  })

const docSource: DocumentCitationSource = {
  id: 'file-1:ch.txt:1',
  title: "Newton's Universal Law of Gravitation",
  url: 'https://openstax.org/books/astronomy/pages/3-3',
  siteName: 'Astronomy',
  isPrimary: true,
  documentMeta: { fileId: 'file-1', fileName: 'ch.txt', pageNumber: 1, contributors: 'Aruna Nair', score: 0.9 },
}

describe('CitationRow', () => {
  it('renders the title, page indicator, "author, in book" subtitle, and relevance bars', () => {
    renderWithProvider(<CitationRow source={docSource} index={1} />)

    expect(screen.getByText("Newton's Universal Law of Gravitation")).toBeInTheDocument()
    expect(screen.getByText('(p. 1)')).toBeInTheDocument()
    expect(screen.getByText('Aruna Nair, in Astronomy')).toBeInTheDocument()
    expect(screen.getByLabelText(/relevance/i)).toBeInTheDocument()
    expect(screen.getByText('1.')).toBeInTheDocument()
  })

  it('omits the page and contributors when absent (subtitle falls back to the book)', () => {
    const minimal = { ...docSource, documentMeta: { fileId: 'file-1', fileName: 'ch.txt' } }
    renderWithProvider(<CitationRow source={minimal} />)

    expect(screen.getByText('Astronomy')).toBeInTheDocument()
    expect(screen.queryByText(/^\(p\./)).toBeNull()
  })

  it('falls back to the in-app document viewer when there is no source URL', () => {
    const captured: { sideview: { sideviewType: string | null; sideviewId: string | null } | null } = {
      sideview: null,
    }
    const Capture = () => {
      const { state } = useContentView()
      captured.sideview =
        state.type === 'sideview' ? { sideviewType: state.data.sideviewType, sideviewId: state.data.sideviewId } : null
      return null
    }

    renderWithProvider(
      <>
        <CitationRow source={{ ...docSource, url: '' }} />
        <Capture />
      </>,
    )

    fireEvent.click(screen.getByRole('listitem'))

    expect(captured.sideview).toEqual({ sideviewType: 'document', sideviewId: 'file-1:ch.txt:1' })
  })
})
