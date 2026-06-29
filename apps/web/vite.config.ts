import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
    tailwindcss(),
    // SPA mode: prerender the root shell to a static index.html and let the
    // client handle all routing. No SSR runtime — the app is entirely
    // client-side (WebGPU/canvas), so the build emits plain static assets.
    tanstackStart({ spa: { enabled: true, prerender: { outputPath: '/index' } } }),
    viteReact(),
  ],
})

export default config
