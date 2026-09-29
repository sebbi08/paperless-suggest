// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { TagEntry } from './editState'
import { TagEditor } from './TagEditor'
import { makeDetail } from './test/fixtures'

const options = makeDetail().vocabulary.tags

function setup(initial: TagEntry[]) {
  const onChange = vi.fn()
  function Harness() {
    const [value, setValue] = useState(initial)
    return (
      <TagEditor
        value={value}
        options={options}
        onChange={(next) => {
          setValue(next)
          onChange(next)
        }}
      />
    )
  }
  render(<Harness />)
  return { onChange, user: userEvent.setup(), last: () => onChange.mock.calls.at(-1)?.[0] as TagEntry[] }
}

const initial: TagEntry[] = [
  { kind: 'existing', id: 2, matchedFrom: 'Rechnungen' },
  { kind: 'existing', id: 5 },
  { kind: 'new', name: 'Mobilfunk', nearest: [{ id: 3, name: 'Telefon/Internet', score: 0.4 }] },
]

describe('TagEditor', () => {
  it('shows existing chips, NEW chips with alternatives, and match notes', () => {
    setup(initial)
    expect(screen.getByText('Rechnung')).toBeInTheDocument()
    expect(screen.getByText('Müller "Bau"')).toBeInTheDocument()
    expect(screen.getByText('NEW: Mobilfunk')).toBeInTheDocument()
    expect(screen.getByText(/matched from “Rechnungen”/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use Telefon/Internet instead of Mobilfunk' })).toBeInTheDocument()
  })

  it('swaps a NEW chip for a suggested existing tag', async () => {
    const { user, last } = setup(initial)
    await user.click(screen.getByRole('button', { name: 'Use Telefon/Internet instead of Mobilfunk' }))
    expect(last()).toEqual([initial[0], initial[1], { kind: 'existing', id: 3 }])
    expect(screen.queryByText('NEW: Mobilfunk')).not.toBeInTheDocument()
  })

  it('removes chips', async () => {
    const { user, last } = setup(initial)
    await user.click(screen.getByRole('button', { name: 'Remove Rechnung' }))
    expect(last()).toEqual([initial[1], initial[2]])
  })

  it('adds an existing tag via search and Enter', async () => {
    const { user, last } = setup([])
    await user.click(screen.getByRole('button', { name: '+ add tag' }))
    await user.type(screen.getByLabelText('Search tags'), 'vers{Enter}')
    expect(last()).toEqual([{ kind: 'existing', id: 4 }])
    expect(screen.queryByLabelText('Search tags')).not.toBeInTheDocument()
  })

  it('creates a NEW tag from the search box', async () => {
    const { user, last } = setup([])
    await user.click(screen.getByRole('button', { name: '+ add tag' }))
    await user.type(screen.getByLabelText('Search tags'), 'Steuer')
    await user.click(screen.getByRole('button', { name: 'Create new tag “Steuer”' }))
    expect(last()).toEqual([{ kind: 'new', name: 'Steuer', nearest: expect.any(Array) }])
  })

  it('closes the search on Escape without changes', async () => {
    const { user, onChange } = setup([])
    await user.click(screen.getByRole('button', { name: '+ add tag' }))
    await user.type(screen.getByLabelText('Search tags'), 'x{Escape}')
    expect(screen.queryByLabelText('Search tags')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })
})
