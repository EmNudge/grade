import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

// Resolve the workspace packages to their TS source so Vite transpiles them as
// first-class app code (they ship .ts via exports, not built .js).
const pkg = (name: string, sub: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/${sub}`, import.meta.url))

const config = defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      '@grade/color': pkg('color', 'index.ts'),
      '@grade/engine': pkg('engine', 'index.ts'),
      '@grade/nodes': pkg('nodes', 'index.ts'),
    },
  },
  plugins: [
    devtools(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
