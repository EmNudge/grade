import { useEffect, useState } from 'react'
import { Volume1, Volume2, VolumeX } from 'lucide-react'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Slider } from '../ui/slider'

/**
 * Audio control for the clip. The clip autoplays muted (browsers block
 * autoplay with sound), so this is how the user brings audio in: click the
 * speaker to mute/unmute, or open it to raise/lower the volume.
 */
export function VolumeControl({ video }: { video: HTMLVideoElement | null }) {
  const [muted, setMuted] = useState(true)
  const [volume, setVolume] = useState(1)

  useEffect(() => {
    if (!video) return undefined
    const sync = () => {
      setMuted(video.muted || video.volume === 0)
      setVolume(video.volume)
    }
    sync()
    video.addEventListener('volumechange', sync)
    return () => video.removeEventListener('volumechange', sync)
  }, [video])

  const setVol = (next: number | readonly number[]) => {
    if (!video) return
    const v = Array.isArray(next) ? next[0] : (next as number)
    video.volume = v
    video.muted = v === 0
  }

  const toggleMute = () => {
    if (!video) return
    if (video.muted || video.volume === 0) {
      video.muted = false
      if (video.volume === 0) video.volume = 1
    } else {
      video.muted = true
    }
  }

  const Icon = muted ? VolumeX : volume < 0.5 ? Volume1 : Volume2

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="sm" variant="ghost" className="size-7 shrink-0 p-0" disabled={!video} />
        }
      >
        <Icon className="size-4" />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-44">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" className="size-7 shrink-0 p-0" onClick={toggleMute}>
            <Icon className="size-4" />
          </Button>
          <Slider
            className="flex-1"
            value={[muted ? 0 : volume]}
            min={0}
            max={1}
            step={0.01}
            onValueChange={setVol}
          />
          <span className="w-7 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
            {Math.round((muted ? 0 : volume) * 100)}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
