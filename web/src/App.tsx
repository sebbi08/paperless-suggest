import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { UnauthorizedError } from './api'
import { Login } from './Login'
import { ReviewScreen } from './ReviewScreen'
import { StatusBar } from './StatusBar'

export function App() {
  const [needsLogin, setNeedsLogin] = useState(false)
  const [client] = useState(() => {
    const onError = (e: unknown) => {
      if (e instanceof UnauthorizedError) setNeedsLogin(true)
    }
    return new QueryClient({
      queryCache: new QueryCache({ onError }),
      mutationCache: new MutationCache({ onError }),
      defaultOptions: {
        queries: {
          retry: (count, e) => !(e instanceof UnauthorizedError) && count < 2,
          refetchOnWindowFocus: false,
        },
      },
    })
  })

  return (
    <QueryClientProvider client={client}>
      {needsLogin ? (
        <Login
          onSuccess={() => {
            setNeedsLogin(false)
            void client.resetQueries()
          }}
        />
      ) : (
        <div className="min-h-dvh bg-white text-gray-900">
          <StatusBar />
          <ReviewScreen />
        </div>
      )}
    </QueryClientProvider>
  )
}
