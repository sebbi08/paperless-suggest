// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { ReviewScreen } from './ReviewScreen'
import { makeDetail, makeStatus } from './test/fixtures'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: { login: vi.fn(), status: vi.fn(), nextDocument: vi.fn(), document: vi.fn(), apply: vi.fn(), regenerate: vi.fn() },
  }
})
const mocked = vi.mocked(api)

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ReviewScreen />
    </QueryClientProvider>,
  )
  return userEvent.setup()
}

beforeEach(() => {
  vi.resetAllMocks()
  mocked.status.mockResolvedValue(makeStatus())
  mocked.nextDocument.mockImplementation(async (after?: number) => ({
    documentId: after === undefined ? 1 : after === 1 ? 2 : null,
  }))
  mocked.document.mockImplementation(async (id: number) => makeDetail({ id }))
  mocked.apply.mockResolvedValue({ status: 'applied' })
  mocked.regenerate.mockResolvedValue({ status: 'pending' })
})

describe('ReviewScreen', () => {
  it('shows the suggestion with the original title struck through', async () => {
    renderScreen()
    expect(await screen.findByDisplayValue('Telekom Rechnung 1')).toBeInTheDocument()
    expect(screen.getByText('scan_1')).toHaveClass('line-through')
    expect(screen.getByLabelText('Correspondent')).toHaveValue('10')
    expect(screen.getByText('Rechnung')).toBeInTheDocument()
    expect(screen.getByText('NEW: Mobilfunk')).toBeInTheDocument()
  })

  it('applies with Enter and moves to the next document', async () => {
    const user = renderScreen()
    await screen.findByDisplayValue('Telekom Rechnung 1')
    await user.keyboard('{Enter}')
    expect(await screen.findByDisplayValue('Telekom Rechnung 2')).toBeInTheDocument()
    expect(mocked.apply).toHaveBeenCalledWith(1, {
      title: 'Telekom Rechnung 1',
      correspondent: { id: 10 },
      tags: [{ id: 2 }, { name: 'Mobilfunk' }],
      expectedModified: '2026-09-14T10:00:01+02:00',
    })
  })

  it('skips with S without applying', async () => {
    const user = renderScreen()
    await screen.findByDisplayValue('Telekom Rechnung 1')
    await user.keyboard('s')
    expect(await screen.findByDisplayValue('Telekom Rechnung 2')).toBeInTheDocument()
    expect(mocked.apply).not.toHaveBeenCalled()
  })

  it('ignores S and R while typing in the title', async () => {
    const user = renderScreen()
    const title = await screen.findByDisplayValue('Telekom Rechnung 1')
    await user.type(title, ' sr')
    expect(title).toHaveValue('Telekom Rechnung 1 sr')
    expect(screen.queryByDisplayValue('Telekom Rechnung 2')).not.toBeInTheDocument()
    expect(mocked.regenerate).not.toHaveBeenCalled()
  })

  it('requests a new suggestion with R', async () => {
    const user = renderScreen()
    await screen.findByDisplayValue('Telekom Rechnung 1')
    await user.keyboard('r')
    expect(mocked.regenerate).toHaveBeenCalledWith(1)
  })

  it('applies the edited state after swapping a NEW tag', async () => {
    const user = renderScreen()
    await screen.findByDisplayValue('Telekom Rechnung 1')
    await user.click(screen.getByRole('button', { name: 'Use Telefon/Internet instead of Mobilfunk' }))
    await user.click(screen.getByRole('button', { name: /^Apply/ }))
    expect(mocked.apply).toHaveBeenCalledWith(1, expect.objectContaining({ tags: [{ id: 2 }, { id: 3 }] }))
  })

  it('turns deleted tags into NEW chips on a missing-entity conflict', async () => {
    mocked.apply.mockRejectedValueOnce(
      new ApiError('conflict', 409, { reason: 'missing', missingTagIds: [2], missingCorrespondentId: null }),
    )
    const user = renderScreen()
    await screen.findByDisplayValue('Telekom Rechnung 1')
    await user.click(screen.getByRole('button', { name: /^Apply/ }))
    expect(await screen.findByText(/deleted in Paperless/)).toBeInTheDocument()
    expect(screen.getByText('NEW: Rechnung')).toBeInTheDocument()
  })

  it('warns and offers a reload when the document changed in Paperless', async () => {
    mocked.apply.mockRejectedValueOnce(new ApiError('conflict', 409, { reason: 'modified', current: {} }))
    const user = renderScreen()
    await screen.findByDisplayValue('Telekom Rechnung 1')
    await user.click(screen.getByRole('button', { name: /^Apply/ }))
    expect(await screen.findByText(/changed in Paperless/)).toBeInTheDocument()
    const calls = mocked.document.mock.calls.filter(([id]) => id === 1).length
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    await vi.waitFor(() => expect(mocked.document.mock.calls.filter(([id]) => id === 1).length).toBeGreaterThan(calls))
  })

  it('shows the empty state with waiting count', async () => {
    mocked.nextDocument.mockResolvedValue({ documentId: null })
    renderScreen()
    expect(await screen.findByText('Nothing to review right now')).toBeInTheDocument()
    expect(await screen.findByText(/3 documents waiting for the LLM/)).toBeInTheDocument()
  })

  it('shows the error reason and falls back to current values', async () => {
    mocked.document.mockResolvedValue(
      makeDetail({ id: 1, suggestion: { status: 'error', error: 'Invalid model output after 2 attempts', title: null } }),
    )
    renderScreen()
    expect(await screen.findByText(/Invalid model output after 2 attempts/)).toBeInTheDocument()
    expect(screen.getByLabelText('Title')).toHaveValue('scan_1')
  })
})
