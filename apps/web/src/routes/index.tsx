import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Editor } from '../components/editor/editor'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  // The editor depends on WebGPU, canvas, and React Flow — all client-only.
  // Render a placeholder during SSR / first paint, then mount the real editor.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  if (!mounted) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
        Loading Grade…
      </div>
    )
  }
  return <Editor />
}
