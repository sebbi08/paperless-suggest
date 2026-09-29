import { setupServer, type SetupServerApi } from 'msw/node'
import { afterAll, afterEach, beforeAll } from 'vitest'

export function useMswServer(): SetupServerApi {
  const server = setupServer() as SetupServerApi
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())
  return server
}
