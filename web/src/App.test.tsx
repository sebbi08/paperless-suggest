// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, UnauthorizedError } from './api'
import { App } from './App'
import { makeStatus } from './test/fixtures'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: { login: vi.fn(), status: vi.fn(), nextDocument: vi.fn(), document: vi.fn(), apply: vi.fn(), regenerate: vi.fn() },
  }
})
const mocked = vi.mocked(api)

let authed = false
beforeEach(() => {
  vi.resetAllMocks()
  authed = false
  mocked.status.mockImplementation(async () => {
    if (!authed) throw new UnauthorizedError()
    return makeStatus()
  })
  mocked.nextDocument.mockImplementation(async () => {
    if (!authed) throw new UnauthorizedError()
    return { documentId: null }
  })
})

describe('App', () => {
  it('asks for the password on 401 and continues after signing in', async () => {
    mocked.login.mockImplementation(async () => {
      authed = true
      return { ok: true }
    })
    const user = userEvent.setup()
    render(<App />)
    await user.type(await screen.findByLabelText('Password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Nothing to review right now')).toBeInTheDocument()
    expect(await screen.findByText(/2 ready · 3 waiting for LLM/)).toBeInTheDocument()
    expect(mocked.login).toHaveBeenCalledWith('pw')
  })

  it('shows a wrong-password message', async () => {
    mocked.login.mockRejectedValue(new UnauthorizedError())
    const user = userEvent.setup()
    render(<App />)
    await user.type(await screen.findByLabelText('Password'), 'nope')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Wrong password')).toBeInTheDocument()
  })
})
