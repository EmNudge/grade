import { type RefObject, useEffect, useRef, useState } from 'react'
import { Engine } from '@grade/engine'
import { registry } from './registry'
import { useEditor } from './store'

export type EngineStatus = 'unsupported' | 'initializing' | 'ready' | 'error'

interface EngineState {
  status: EngineStatus
  message: string
  adapter?: string
}

/**
 * Owns the WebGPU Engine bound to `canvasRef`. Re-compiles when the graph
 * *structure* changes, live-pushes parameter edits, and feeds it the imported
 * clip. The render loop runs continuously so video playback updates the viewer.
 */
export function useEngine(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  video: HTMLVideoElement | null,
): EngineState {
  const engineRef = useRef<Engine | null>(null)
  const [state, setState] = useState<EngineState>({
    status: 'initializing',
    message: 'Starting WebGPU…',
  })

  // Track the latest clip so the engine can pick it up even if it finished
  // initializing after the clip was imported.
  const videoElRef = useRef(video)
  videoElRef.current = video

  // Create the engine once the canvas is mounted.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    if (!Engine.isSupported()) {
      setState({ status: 'unsupported', message: 'WebGPU is not available in this browser.' })
      return undefined
    }
    let disposed = false
    Engine.create(canvas, registry)
      .then((engine) => {
        if (disposed) {
          engine.dispose()
          return undefined
        }
        engineRef.current = engine
        engine.setGraph(useEditor.getState().toGraph())
        if (videoElRef.current) engine.setSource(videoElRef.current)
        engine.start()
        useEditor.getState().setEngine(engine)
        setState({ status: 'ready', message: 'WebGPU ready', adapter: engine.info.adapter })
        return undefined
      })
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      disposed = true
      useEditor.getState().setEngine(null)
      engineRef.current?.dispose()
      engineRef.current = null
    }
  }, [canvasRef])

  // Recompile on structural changes (nodes added/removed, edges rewired).
  const structureKey = useEditor((s) => s.structureKey())
  useEffect(() => {
    engineRef.current?.setGraph(useEditor.getState().toGraph())
  }, [structureKey])

  // Live-push parameter edits without recompiling pipelines. Each FX in a
  // node's stack is its own engine pass, keyed `${nodeId}:${fxId}`.
  const nodes = useEditor((s) => s.nodes)
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    for (const n of nodes) {
      for (const fx of n.data.fx) engine.setNodeValues(`${n.id}:${fx.id}`, fx.values)
    }
  }, [nodes])

  // Feed the imported clip.
  useEffect(() => {
    if (video) engineRef.current?.setSource(video)
  }, [video])

  return state
}
