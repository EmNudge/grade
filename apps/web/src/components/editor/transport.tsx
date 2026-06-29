import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
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

  return (
    <div className="flex items-center gap-3 border-t border-border bg-background px-3 py-2">
      <Button size="sm" variant="ghost" onClick={toggle} disabled={!video} className="size-7 p-0">
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </Button>
      <span className="w-16 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
        {fmt(time)}
      </span>
      <Slider
        className="flex-1 [&_[data-slot=slider-track]]:h-1.5"
        value={[Math.min(time, duration || 0)]}
        min={0}
        max={duration || 1}
        step={0.01}
        disabled={!video || duration === 0}
        onValueChange={seek}
        onValueCommitted={commitSeek}
      />
      <span className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {fmt(duration)}
      </span>
      <VolumeControl video={video} />
    </div>
  )
}
