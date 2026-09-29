import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { server: 'src/server.ts', eval: 'src/eval/run.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  sourcemap: true,
  clean: false, // dist/web is written by the Vite build that runs first
})
