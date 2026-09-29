// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CorrespondentPicker } from './CorrespondentPicker'
import type { CorrespondentEntry } from './editState'
import { makeDetail } from './test/fixtures'

const options = makeDetail().vocabulary.correspondents

function setup(initial: CorrespondentEntry) {
  const onChange = vi.fn()
  function Harness() {
    const [value, setValue] = useState(initial)
    return (
      <CorrespondentPicker
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
  return { user: userEvent.setup(), last: () => onChange.mock.calls.at(-1)?.[0] as CorrespondentEntry }
}

describe('CorrespondentPicker', () => {
  it('selects existing correspondents or none', async () => {
    const { user, last } = setup({ kind: 'existing', id: 10 })
    expect(screen.getByLabelText('Correspondent')).toHaveValue('10')
    await user.selectOptions(screen.getByLabelText('Correspondent'), '11')
    expect(last()).toEqual({ kind: 'existing', id: 11 })
    await user.selectOptions(screen.getByLabelText('Correspondent'), '')
    expect(last()).toBeNull()
  })

  it('shows a match note', () => {
    setup({ kind: 'existing', id: 10, matchedFrom: 'Telekom' })
    expect(screen.getByText(/matched from “Telekom”/)).toBeInTheDocument()
  })

  it('creates a new correspondent and offers similar existing ones', async () => {
    const { user, last } = setup(null)
    await user.selectOptions(screen.getByLabelText('Correspondent'), 'Create new…')
    await user.type(screen.getByLabelText('New correspondent name'), 'Telekom')
    expect(last()).toMatchObject({ kind: 'new', name: 'Telekom' })
    await user.click(screen.getByRole('button', { name: 'Use Deutsche Telekom AG instead' }))
    expect(last()).toEqual({ kind: 'existing', id: 10 })
  })

  it('renders a proposed correspondent as NEW with alternatives', () => {
    setup({ kind: 'new', name: 'Telekom Deutschland', nearest: [{ id: 10, name: 'Deutsche Telekom AG', score: 0.8 }] })
    expect(screen.getByLabelText('New correspondent name')).toHaveValue('Telekom Deutschland')
    expect(screen.getByRole('button', { name: 'Use Deutsche Telekom AG instead' })).toBeInTheDocument()
  })
})
