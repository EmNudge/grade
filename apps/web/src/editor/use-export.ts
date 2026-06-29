import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  type ExportFormat,
  type ExportQuality,
  exportFilename,
  exportGradedVideo,
  isExportSupported,
} from './export'
import { pickSaveFile, writeSaveFile } from './save-file'
import { useEditor } from './store'

/** Native save-dialog accept map per container format. */
const ACCEPT: Record<ExportFormat, { description: string; accept: Record<string, string[]> }> = {
  mp4: { description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } },
  webm: { description: 'WebM video', accept: { 'video/webm': ['.webm'] } },
}

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

    // Grab the save target first, while we still have the click's user
    // activation — the picker can't open after the multi-second encode. A null
    // result means the user dismissed the dialog, so there's nothing to export.
    const target = await pickSaveFile({
      suggestedName: exportFilename(settings.format, clipName ?? undefined),
      ...ACCEPT[settings.format],
    })
    if (!target) return

    const ac = new AbortController()
    abortRef.current = ac
    setPhase('exporting')
    setProgress(0)
    setError(null)

    const wasPlaying = !video.paused
    const prevTime = video.currentTime
    engine.stop()
    video.pause()

    // With a real file handle we stream the muxer output straight to disk; the
    // download fallback (no handle) still buffers a Blob to save at the end.
    let writable: FileSystemWritableFileStream | null = null
    try {
      writable = target.handle ? await target.handle.createWritable() : null
      const result = await exportGradedVideo(engine, video, {
        format: settings.format,
        quality: settings.quality,
        fps: settings.fps,
        audio: settings.audio,
        ...(clipName ? { name: clipName } : {}),
        ...(writable ? { writable } : {}),
        signal: ac.signal,
        onProgress: (done, total) => setProgress(done / total),
      })
      // Streaming already wrote and closed the file; otherwise save the Blob.
      if (!writable) await writeSaveFile(target, result.blob as Blob)
      setPhase('done')
      const audioNote = settings.audio && !result.hasAudio ? ' · no audio track found' : ''
      toast.success(`Exported ${target.filename}`, {
        description: `${result.width}×${result.height} · ${result.frames} frames${audioNote}`,
      })
    } catch (err) {
      // Discard the half-written file so we never leave a corrupt output behind.
      if (writable) {
        try {
          await writable.abort()
        } catch {
          // already closed/aborted — nothing to undo
        }
      }
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
