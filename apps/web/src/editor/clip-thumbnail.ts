// Off-screen thumbnail generation for imported footage. Decodes a clip in a
// detached <video> (independent of the viewer) so we can grab a bin tile for
// every clip the moment it's added — not just the one playing — and build the
// small filmstrip the timeline shows on hover.

/** Resolve once `event` fires on `el`, or reject if it errors first. */
function once(el: HTMLVideoElement, event: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const onOk = () => {
      cleanup()
      resolve()
    }
    const onErr = () => {
      cleanup()
      reject(new Error(`video ${event} failed`))
    }
    const onAbort = () => {
      cleanup()
      reject(new DOMException('aborted', 'AbortError'))
    }
    const cleanup = () => {
      el.removeEventListener(event, onOk)
      el.removeEventListener('error', onErr)
      signal?.removeEventListener('abort', onAbort)
    }
    el.addEventListener(event, onOk, { once: true })
    el.addEventListener('error', onErr, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** A muted, detached video element wired up to decode `file` off-screen. */
function makeVideo(file: File): { video: HTMLVideoElement; url: string } {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.crossOrigin = 'anonymous'
  video.preload = 'auto'
  video.src = url
  return { video, url }
}

/** Draw the current frame of `video` to a `width`px-wide JPEG data URL. */
function frameToDataUrl(video: HTMLVideoElement, width: number): string | null {
  if (!video.videoWidth) return null
  const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * width))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, width, h)
  return canvas.toDataURL('image/jpeg', 0.6)
}

/**
 * Grab a single bin thumbnail (≈1s in, to skip black leader/fades) for `file`.
 * Returns null if decoding fails. Always tears the detached video down.
 */
export async function generateClipThumbnail(file: File, width = 128): Promise<string | null> {
  const { video, url } = makeVideo(file)
  try {
    await once(video, 'loadeddata')
    const target = Math.min(1, (video.duration || 0) / 2)
    if (target > 0.05) {
      video.currentTime = target
      await once(video, 'seeked')
    }
    return frameToDataUrl(video, width)
  } catch {
    return null
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

/**
 * Build a `count`-frame filmstrip across the whole clip, calling `onFrame` with
 * each thumbnail as it decodes (progressive — so the timeline can show what's
 * ready without waiting for the slowest seek). Frames are tiny by design: the
 * count is fixed regardless of duration, since the hover strip only has so much
 * room. Honours `signal` so switching clips cancels an in-flight strip.
 */
export async function generateFilmstrip(
  file: File,
  count: number,
  onFrame: (index: number, url: string) => void,
  signal: AbortSignal,
  width = 96,
): Promise<void> {
  const { video, url } = makeVideo(file)
  try {
    await once(video, 'loadeddata', signal)
    const dur = video.duration
    if (!Number.isFinite(dur) || dur <= 0) return
    for (let i = 0; i < count; i++) {
      if (signal.aborted) return
      // Sample at each cell's centre so the strip reads evenly across the clip.
      video.currentTime = ((i + 0.5) / count) * dur
      await once(video, 'seeked', signal)
      const frame = frameToDataUrl(video, width)
      if (frame) onFrame(i, frame)
    }
  } catch {
    // Aborted or undecodable — leave whatever frames already landed.
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}
