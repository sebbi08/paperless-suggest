import { setupServer, type SetupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll } from 'vitest'

export function useMswServer(): SetupServer {
  const server = setupServer()
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())
  return server
}
