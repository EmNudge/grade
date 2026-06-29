import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  type ExportFormat,
  type ExportQuality,
  exportGradedVideo,
  isExportSupported,
} from './export'
import { useEditor } from './store'

export type ExportPhase = 'idle' | 'exporting' | 'done' | 'error'

export interface ExportSettings {
  format: ExportFormat
  quality: ExportQuality
  fps: number
  audio: boolean
}

interface ExportState {
  phase: ExportPhase
  progress: number // 0..1
  error: string | null
  supported: boolean
  run: (settings: ExportSettings) => Promise<void>
  cancel: () => void
}

/**
 * Drives a full export: pauses live playback, hands the engine + clip to the
 * frame-stepping exporter, streams progress, and downloads the finished file.
 * Restores playback state when done or cancelled.
 */
export function useExport(): ExportState {
  const [phase, setPhase] = useState<ExportPhase>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const run = useCallback(async (settings: ExportSettings) => {
    const { engine, video, clipName } = useEditor.getState()
    if (!engine || !video) {
      setError('Load a clip before exporting.')
      setPhase('error')
      return
    }

    const ac = new AbortController()
    abortRef.current = ac
    setPhase('exporting')
    setProgress(0)
    setError(null)

    const wasPlaying = !video.paused
    const prevTime = video.currentTime
    engine.stop()
    video.pause()

    try {
      const result = await exportGradedVideo(engine, video, {
        format: settings.format,
        quality: settings.quality,
        fps: settings.fps,
        audio: settings.audio,
        ...(clipName ? { name: clipName } : {}),
        signal: ac.signal,
        onProgress: (done, total) => setProgress(done / total),
      })
      downloadBlob(result.blob, result.filename)
      setPhase('done')
      const audioNote = settings.audio && !result.hasAudio ? ' · no audio track found' : ''
      toast.success(`Exported ${result.filename}`, {
        description: `${result.width}×${result.height} · ${result.frames} frames${audioNote}`,
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setPhase('idle')
      } else {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setPhase('error')
        toast.error('Export failed', { description: message })
      }
    } finally {
      abortRef.current = null
      try {
        video.currentTime = prevTime
      } catch {
        // ignore — element may have been replaced mid-export
      }
      engine.start()
      if (wasPlaying) void video.play().catch(() => {})
    }
  }, [])

  const cancel = useCallback(() => abortRef.current?.abort(), [])

  return { phase, progress, error, supported: isExportSupported(), run, cancel }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke after the click has had a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
