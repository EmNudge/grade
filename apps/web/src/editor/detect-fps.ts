// Estimate a clip's source frame rate. HTMLVideoElement exposes no frame-rate
// property, so we sample `requestVideoFrameCallback` while the clip plays and
// derive the rate from the spacing of presented frames' media timestamps.

type FrameMeta = { mediaTime: number; presentedFrames: number }
type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

/** Common capture/broadcast rates we snap to when the estimate is close. */
const STANDARD_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120]

/**
 * Resolve the detected source fps, or null if it can't be determined (no rVFC
 * support, or not enough frames presented within the timeout). The clip should
 * be playing for frames to be presented.
 */
export function detectSourceFps(
  video: HTMLVideoElement,
  samples = 12,
  timeoutMs = 2500,
): Promise<number | null> {
  const vfc = video as VideoWithRvfc
  if (typeof vfc.requestVideoFrameCallback !== 'function') return Promise.resolve(null)

  return new Promise((resolve) => {
    const mediaTimes: number[] = []
    let handle = 0
    let done = false

    const finish = (value: number | null) => {
      if (done) return
      done = true
      if (handle && vfc.cancelVideoFrameCallback) vfc.cancelVideoFrameCallback(handle)
      clearTimeout(timer)
      // oxlint-disable-next-line promise/no-multiple-resolved -- single fire: guarded by the `done` flag
      resolve(value)
    }

    const onFrame = (_now: number, meta: FrameMeta) => {
      const last = mediaTimes[mediaTimes.length - 1]
      if (last === undefined || meta.mediaTime > last + 1e-4) mediaTimes.push(meta.mediaTime)
      if (mediaTimes.length >= samples) {
        finish(estimateFps(mediaTimes))
        return
      }
      handle = vfc.requestVideoFrameCallback(onFrame)
    }

    handle = vfc.requestVideoFrameCallback(onFrame)
    const timer = setTimeout(
      () => finish(mediaTimes.length >= 4 ? estimateFps(mediaTimes) : null),
      timeoutMs,
    )
  })
}

function estimateFps(mediaTimes: number[]): number | null {
  const deltas: number[] = []
  for (let i = 1; i < mediaTimes.length; i++) {
    const a = mediaTimes[i - 1]
    const b = mediaTimes[i]
    if (a !== undefined && b !== undefined && b > a) deltas.push(b - a)
  }
  if (deltas.length === 0) return null

  deltas.sort((a, b) => a - b)
  const median = deltas[Math.floor(deltas.length / 2)]
  if (median === undefined || median <= 0) return null

  const fps = 1 / median
  if (!Number.isFinite(fps) || fps <= 0) return null

  // Snap to the nearest standard rate when within 5%, else round to 0.01 fps.
  let best = fps
  let bestDiff = Infinity
  for (const rate of STANDARD_RATES) {
    const diff = Math.abs(rate - fps)
    if (diff < bestDiff) {
      bestDiff = diff
      best = rate
    }
  }
  return bestDiff / fps <= 0.05 ? best : Math.round(fps * 100) / 100
}

/** Display a frame rate without trailing-zero noise (30, 23.976, 29.97). */
export function formatFps(fps: number): string {
  return Number(fps.toFixed(3)).toString()
}
