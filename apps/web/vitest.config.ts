import { fileURLToPath } from 'node:url'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// A dedicated Vitest config so tests don't inherit vite.config.ts — the
// Cloudflare/TanStack-Start plugins there are incompatible with Vitest's SSR
// environment. Mirrors the @grade/* source aliases so app code resolves.
const pkg = (name: string, sub: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/${sub}`, import.meta.url))

export default defineConfig({
  plugins: [viteReact()],
  resolve: {
    alias: {
      '@grade/color': pkg('color', 'index.ts'),
      '@grade/engine': pkg('engine', 'index.ts'),
      '@grade/nodes': pkg('nodes', 'index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    passWithNoTests: true,
  },
})
