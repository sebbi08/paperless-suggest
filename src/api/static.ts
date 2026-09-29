import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Handler } from 'hono'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}

/** Serves files from rootDir; unknown paths get index.html so client-side routes work. */
export function serveSpa(rootDir: string): Handler {
  const root = path.resolve(rootDir)
  const index = path.join(root, 'index.html')
  return async (c) => {
    let file = index
    try {
      const rel = decodeURIComponent(new URL(c.req.url).pathname)
      const candidate = path.resolve(root, `.${rel}`)
      if (candidate.startsWith(root + path.sep) && (await stat(candidate).catch(() => null))?.isFile()) {
        file = candidate
      }
    } catch {
      file = index
    }
    const body = new Uint8Array(await readFile(file))
    const immutable = file.startsWith(path.join(root, 'assets') + path.sep)
    return c.body(body, 200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
  }
}
