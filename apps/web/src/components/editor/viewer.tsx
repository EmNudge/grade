import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { detectSourceFps } from '../../editor/detect-fps'
import { useEngine } from '../../editor/use-engine'
import { useEditor } from '../../editor/store'
import { Button } from '../ui/button'
import { StillsGallery } from './stills-gallery'
import { Transport } from './transport'

/** Seconds → m:ss.ss, for a still's capture-time label. */
function formatTime(t: number): string {
  const m = Math.floor(t / 60)
  const s = (t % 60).toFixed(2).padStart(5, '0')
  return `${m}:${s}`
}

/** Grab the engine's current graded frame as a JPEG data URL (capped width). */
async function grabStill(
  engine: NonNullable<ReturnType<typeof useEditor.getState>['engine']>,
): Promise<string | null> {
  const dims = engine.dimensions
  if (!dims.width) return null
  const w = Math.min(480, dims.width)
  const h = Math.max(1, Math.round((dims.height / dims.width) * w))
  const frame = await engine.sampleScopes(w, h)
  if (!frame) return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const out = ctx.createImageData(w, h)
  const bgra = frame.format === 'BGRA'
  const d = frame.data
  for (let i = 0; i < w * h * 4; i += 4) {
    out.data[i] = d[bgra ? i + 2 : i] ?? 0
    out.data[i + 1] = d[i + 1] ?? 0
    out.data[i + 2] = d[bgra ? i : i + 2] ?? 0
    out.data[i + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
  return canvas.toDataURL('image/jpeg', 0.85)
}

export function Viewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const [clipName, setClipName] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const dragDepth = useRef(0)
  const registerVideo = useEditor((s) => s.setVideo)
  const registerCanvas = useEditor((s) => s.setCanvas)
  const registerClipName = useEditor((s) => s.setClipName)
  const registerClipFps = useEditor((s) => s.setClipFps)
  const addStill = useEditor((s) => s.addStill)
  const hoveredStillId = useEditor((s) => s.hoveredStillId)
  const stills = useEditor((s) => s.stills)
  const hoveredStill = hoveredStillId ? stills.find((x) => x.id === hoveredStillId) : null

  const engine = useEngine(canvasRef, video)

  const captureStill = useCallback(async () => {
    setMenu(null)
    const eng = useEditor.getState().engine
    if (!eng) return
    try {
      const url = await grabStill(eng)
      if (!url) {
        toast.error('No frame to capture yet')
        return
      }
      const time = videoRef.current?.currentTime ?? 0
      addStill({ url, time, label: formatTime(time) })
      toast.success('Still captured')
    } catch {
      toast.error('Could not capture still')
    }
  }, [addStill])

  useEffect(() => {
    registerCanvas(canvasRef.current)
    return () => registerCanvas(null)
  }, [registerCanvas])

  // Lazily create the off-DOM video element used as the GPU frame source.
  const ensureVideo = useCallback(() => {
    if (!videoRef.current) {
      const el = document.createElement('video')
      el.muted = true
      el.loop = true
      el.playsInline = true
      el.crossOrigin = 'anonymous'
      videoRef.current = el
    }
    return videoRef.current
  }, [])

  const loadFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith('video/')) return
      const el = ensureVideo()
      el.src = URL.createObjectURL(file)
      setClipName(file.name)
      registerClipName(file.name)
      registerClipFps(null)
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- single reused <video> element; assignment intentionally replaces the prior load's handler instead of stacking
      el.onloadedmetadata = () => {
        const c = canvasRef.current
        if (c) {
          c.width = el.videoWidth
          c.height = el.videoHeight
        }
        setVideo(el)
        registerVideo(el)
        void el.play().catch(() => {})
        // Estimate the clip's frame rate while it plays, for the export default.
        void detectSourceFps(el).then((fps) => registerClipFps(fps))
      }
    },
    [ensureVideo, registerVideo, registerClipName, registerClipFps],
  )

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) loadFile(file)
    e.target.value = '' // allow re-picking the same file
  }

  const onDragEnter = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('video/'))
    if (file) loadFile(file)
  }

  // Stop the browser from opening a video file if it's dropped outside the
  // viewer's drop zone (the default action navigates away from the app).
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
      videoRef.current?.removeAttribute('src')
      registerVideo(null)
    }
  }, [registerVideo])

  return (
    <div
      className="flex size-full flex-col bg-black"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border bg-background px-3 py-2">
        <div className="flex items-center gap-2">
          {clipName ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => fileRef.current?.click()}
                className="gap-1.5"
              >
                <Upload className="size-4" /> Replace
              </Button>
              <span className="truncate text-xs text-muted-foreground">{clipName}</span>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">No clip loaded</span>
          )}
        </div>
        <StatusPill
          status={engine.status}
          message={engine.message}
          {...(engine.adapter !== undefined ? { adapter: engine.adapter } : {})}
        />
        <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={onPick} />
      </div>

      <div className="flex min-h-0 flex-1">
        <StillsGallery />
        <div
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
          onContextMenu={(e) => {
            if (!video) return
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY })
          }}
        >
          <canvas
            ref={canvasRef}
            className="max-h-full max-w-full rounded-sm object-contain shadow-lg"
          />
          {/* Preview the hovered still over the live frame. */}
          {hoveredStill && (
            <div className="pointer-events-none absolute inset-4 z-10 flex items-center justify-center">
              <img
                src={hoveredStill.url}
                alt=""
                className="max-h-full max-w-full rounded-sm object-contain shadow-lg ring-1 ring-primary/60"
              />
            </div>
          )}
          {menu && (
            <>
              <div className="fixed inset-0 z-40" onPointerDown={() => setMenu(null)} />
              <div
                className="fixed z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
                style={{ left: menu.x, top: menu.y }}
              >
                <button
                  type="button"
                  onClick={() => void captureStill()}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted"
                >
                  <Camera className="size-3.5" /> Capture still
                </button>
              </div>
            </>
          )}
          {!video && !dragging && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="group absolute inset-3 flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border text-center text-sm text-muted-foreground transition-colors hover:border-primary/60 hover:bg-primary/5 hover:text-foreground"
            >
              <span className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground shadow-sm transition-colors group-hover:bg-secondary/80">
                <Upload className="size-4" /> Import clip
              </span>
              <span className="space-y-1">
                <span className="block">Click anywhere here, or drag a clip in.</span>
                <span className="block text-xs opacity-70">
                  Try DJI D-Log / D-Log M footage — the Color Space Transform maps it to Rec.709.
                </span>
              </span>
            </button>
          )}
          {dragging && (
            <div className="pointer-events-none absolute inset-3 z-10 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-primary/10 text-center text-sm text-foreground backdrop-blur-sm">
              <Upload className="size-7" />
              <p className="font-medium">Drop to load clip</p>
            </div>
          )}
        </div>
      </div>

      {video && <Transport video={video} />}
    </div>
  )
}

function StatusPill({
  status,
  message,
  adapter,
}: {
  status: string
  message: string
  adapter?: string
}) {
  const color =
    status === 'ready'
      ? 'bg-green-500'
      : status === 'error' || status === 'unsupported'
        ? 'bg-red-500'
        : 'bg-amber-500'
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground" title={message}>
      <span className={`size-2 rounded-full ${color}`} />
      <span className="max-w-[220px] truncate">{adapter ?? message}</span>
    </div>
  )
}
