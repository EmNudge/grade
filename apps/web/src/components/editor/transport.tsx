import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { generateFilmstrip } from '../../editor/clip-thumbnail'
import { useEditor } from '../../editor/store'
import { Button } from '../ui/button'
import { Slider } from '../ui/slider'
import { VolumeControl } from './volume-control'

function fmt(t: number): string {
  if (!Number.isFinite(t)) return '0:00.00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const cs = Math.floor((t % 1) * 100)
  return `${m}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`
}

// Fixed number of hover-preview frames regardless of clip length — the strip
// only has so much room, and longer clips just sample more coarsely.
const STRIP_COUNT = 48

/**
 * Decode a small filmstrip for `file` in the background, returning frames as a
 * (sparse-until-ready) array. Switching clips cancels the in-flight strip.
 */
function useFilmstrip(file: File | null): string[] {
  const [frames, setFrames] = useState<string[]>([])
  useEffect(() => {
    setFrames([])
    if (!file) return undefined
    const controller = new AbortController()
    const acc: string[] = []
    void generateFilmstrip(
      file,
      STRIP_COUNT,
      (i, url) => {
        acc[i] = url
        setFrames(acc.slice())
      },
      controller.signal,
    )
    return () => controller.abort()
  }, [file])
  return frames
}

/** Frame at `index`, or the nearest already-decoded one (the strip fills in lazily). */
function nearestFrame(frames: string[], index: number): string | null {
  if (frames[index]) return frames[index] ?? null
  for (let d = 1; d < STRIP_COUNT; d++) {
    if (frames[index - d]) return frames[index - d] ?? null
    if (frames[index + d]) return frames[index + d] ?? null
  }
  return null
}

/**
 * Playback transport + scrubber for the imported clip. Owns its own animation
 * frame so dragging/playing updates the timecode smoothly without re-rendering
 * the viewer. Seeking sets `video.currentTime`; the engine's render loop picks
 * up the new frame on the next tick.
 */
export function Transport({ video }: { video: HTMLVideoElement | null }) {
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)
  const scrubbing = useRef(false)
  // Hover-scrub filmstrip for the active clip.
  const clipFile = useEditor((s) => s.clips.find((c) => c.id === s.activeClipId)?.file ?? null)
  const frames = useFilmstrip(clipFile)
  const [hover, setHover] = useState<{ x: number; frac: number } | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!video) return undefined
    const sync = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0)
      setPlaying(!video.paused)
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    sync()
    video.addEventListener('loadedmetadata', sync)
    video.addEventListener('durationchange', sync)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)

    // Smoothly track currentTime (timeupdate fires too coarsely to scrub by).
    let raf = 0
    const tick = () => {
      if (!scrubbing.current) setTime(video.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      video.removeEventListener('loadedmetadata', sync)
      video.removeEventListener('durationchange', sync)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
    }
  }, [video])

  const seek = (next: number | readonly number[]) => {
    if (!video) return
    const v = Array.isArray(next) ? next[0] : (next as number)
    scrubbing.current = true
    setTime(v)
    video.currentTime = v
  }

  const commitSeek = () => {
    scrubbing.current = false
  }

  const toggle = () => {
    if (!video) return
    if (video.paused) void video.play()
    else video.pause()
  }

  const onTrackMove = (e: React.PointerEvent) => {
    const el = trackRef.current
    if (!el || duration === 0) return
    const r = el.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    setHover({ x: frac * r.width, frac })
  }

  const hoverFrame =
    hover && frames.length > 0
      ? nearestFrame(frames, Math.min(STRIP_COUNT - 1, Math.floor(hover.frac * STRIP_COUNT)))
      : null

  return (
    <div className="flex items-center gap-3 border-t border-border bg-background px-3 py-2">
      <Button size="sm" variant="ghost" onClick={toggle} disabled={!video} className="size-7 p-0">
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </Button>
      <span className="w-16 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
        {fmt(time)}
      </span>
      <div
        ref={trackRef}
        className="relative flex-1"
        onPointerMove={onTrackMove}
        onPointerLeave={() => setHover(null)}
      >
        {hover && (
          <div
            className="pointer-events-none absolute bottom-full z-20 mb-2 w-max -translate-x-1/2"
            style={{ left: Math.round(hover.x) }}
          >
            <div className="overflow-hidden rounded border border-border bg-black shadow-lg">
              {hoverFrame ? (
                <img src={hoverFrame} alt="" className="block h-16 w-auto" draggable={false} />
              ) : (
                <div className="flex h-16 w-28 items-center justify-center text-[10px] text-muted-foreground">
                  …
                </div>
              )}
            </div>
            <div className="mt-0.5 text-center font-mono text-[10px] tabular-nums text-foreground">
              {fmt(hover.frac * duration)}
            </div>
          </div>
        )}
        <Slider
          className="[&_[data-slot=slider-track]]:h-1.5"
          value={[Math.min(time, duration || 0)]}
          min={0}
          max={duration || 1}
          step={0.01}
          disabled={!video || duration === 0}
          onValueChange={seek}
          onValueCommitted={commitSeek}
        />
      </div>
      <span className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {fmt(duration)}
      </span>
      <VolumeControl video={video} />
    </div>
  )
}
