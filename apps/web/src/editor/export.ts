// Frame-accurate export of the graded result, with source audio passthrough.
//
// Video: we don't capture the live preview in real time. Instead we step the
// source video frame by frame, run each frame through the engine's effect
// chain, read the graded canvas back as a `VideoFrame`, and encode it with
// WebCodecs. This is deterministic and independent of playback speed.
//
// Audio: the source's audio is decoded to PCM (resampled to 48 kHz, down-mixed
// to ≤2 channels), then re-encoded — AAC for MP4, Opus for WebM — since the
// source codec won't generally match the output container.
//
// Encoded chunks from both tracks are buffered and handed to the muxer in
// timestamp order, which keeps A/V correctly interleaved for both containers.

import {
  ArrayBufferTarget as Mp4Target,
  FileSystemWritableFileStreamTarget as Mp4StreamTarget,
  Muxer as Mp4Muxer,
} from 'mp4-muxer'
import {
  ArrayBufferTarget as WebmTarget,
  FileSystemWritableFileStreamTarget as WebmStreamTarget,
  Muxer as WebmMuxer,
} from 'webm-muxer'
import type { Engine } from '@grade/engine'

export type ExportFormat = 'mp4' | 'webm'
export type ExportQuality = 'low' | 'medium' | 'high'

export interface ExportOptions {
  format: ExportFormat
  fps: number
  quality: ExportQuality
  /** Include the source clip's audio track (default true). */
  audio?: boolean
  /** Trim range in seconds. Defaults to the whole clip. */
  start?: number
  end?: number
  /** Base name for the downloaded file (extension is added per format). */
  name?: string
  /**
   * When set, the muxer streams the finished file straight to disk through this
   * writable instead of assembling the whole output in memory. The export owns
   * the stream's lifecycle: it closes it on success and aborts it on failure.
   * In that case `ExportResult.blob` is null (nothing left to save).
   */
  writable?: FileSystemWritableFileStream
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

export interface ExportResult {
  /** The encoded file, or null when it was streamed to `opts.writable`. */
  blob: Blob | null
  filename: string
  width: number
  height: number
  frames: number
  hasAudio: boolean
}

/** Target H.264/VP9 bits-per-pixel-per-frame for each quality tier. */
const BITS_PER_PIXEL: Record<ExportQuality, number> = { low: 0.04, medium: 0.1, high: 0.2 }
const AUDIO_BITRATE = 128_000
const AUDIO_SAMPLE_RATE = 48_000 // AAC and Opus both accept this cleanly

/** WebCodecs won't be present in non-WebGPU contexts; gate the UI on this. */
export function isExportSupported(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'
}

/** Suggested output filename for a clip name + format (extension included). */
export function exportFilename(format: ExportFormat, name?: string): string {
  return `${sanitizeName(name) || 'grade-export'}.${format}`
}

/** A muxer chunk awaiting ordered insertion. */
interface PendingChunk {
  kind: 'video' | 'audio'
  timestamp: number
  add: () => void
}

export async function exportGradedVideo(
  engine: Engine,
  video: HTMLVideoElement,
  opts: ExportOptions,
): Promise<ExportResult> {
  if (!isExportSupported()) {
    throw new Error('This browser does not support WebCodecs video export.')
  }

  // Even dimensions are required by H.264 and keep VP9 happy too; crop by at
  // most one pixel from the clip's intrinsic size.
  const dim = engine.dimensions
  const cw = dim.width || engine.outputCanvas.width || video.videoWidth
  const ch = dim.height || engine.outputCanvas.height || video.videoHeight
  const width = cw - (cw % 2)
  const height = ch - (ch % 2)
  if (width < 2 || height < 2) throw new Error('Clip has no decodable dimensions yet.')

  const fps = clampFps(opts.fps)
  const bitrate = Math.round(width * height * fps * BITS_PER_PIXEL[opts.quality])
  const { encoderConfig, muxerCodec } = await pickConfig(opts.format, width, height, fps, bitrate)

  const duration = Number.isFinite(video.duration) ? video.duration : 0
  const start = Math.max(0, opts.start ?? 0)
  const end = Math.max(start, Math.min(opts.end ?? duration, duration || (opts.end ?? 0)))

  // Prepare audio up front so the muxer can be created with both tracks. Any
  // failure (no track, unsupported codec) degrades to a video-only export.
  const audio = opts.audio === false ? null : await prepareAudio(opts.format, video, start, end)

  const muxer = createMuxer(
    opts.format,
    muxerCodec,
    width,
    height,
    fps,
    audio?.muxer,
    opts.writable,
  )

  // Buffer every encoded chunk, then mux in timestamp order at the end.
  const pending: PendingChunk[] = []

  let encodeError: Error | null = null
  const onError = (e: unknown) => {
    encodeError ??= e instanceof Error ? e : new Error(String(e))
  }

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      const c = chunk
      pending.push({ kind: 'video', timestamp: c.timestamp, add: () => muxer.addVideo(c, meta) })
    },
    error: onError,
  })
  videoEncoder.configure(encoderConfig)

  const span = Math.max(1 / fps, end - start)
  const totalFrames = Math.max(1, Math.round(span * fps))
  const frameDurationUs = 1e6 / fps
  // Keyframe roughly every 2s for seekable, reasonably compact output.
  const keyInterval = Math.max(1, Math.round(fps * 2))

  let lastFrame: GpuFrame | null = null
  try {
    for (let i = 0; i < totalFrames; i++) {
      if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
      if (encodeError) throw encodeError

      // Clamp to just inside `end` so the final sample isn't past the last frame.
      const t = Math.min(start + i / fps, Math.max(start, end - 1e-3))
      await seekAndPresent(video, t)

      // Render + read the graded frame straight off the GPU, retrying across a
      // few compositor frames if the seeked frame wasn't importable yet.
      let data: GpuFrame | null = null
      for (let tries = 0; tries < 8 && !data; tries++) {
        data = await engine.readFrame()
        if (!data) await nextRaf()
      }
      if (data) lastFrame = data
      else data = lastFrame // reuse the last good frame on a transient miss
      if (!data) {
        throw new Error('Could not read frames from the clip for export (GPU import failed).')
      }

      const frame = toVideoFrame(
        data,
        width,
        height,
        Math.round(i * frameDurationUs),
        Math.round(frameDurationUs),
      )

      // Apply backpressure so the encode queue doesn't grow unbounded.
      while (videoEncoder.encodeQueueSize > 8) await onceDequeue(videoEncoder)

      videoEncoder.encode(frame, { keyFrame: i % keyInterval === 0 })
      frame.close()
      opts.onProgress?.(i + 1, totalFrames)
    }

    await videoEncoder.flush()
    if (encodeError) throw encodeError

    // Encode audio (fast relative to video) once the frames are done.
    if (audio) {
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          const c = chunk
          pending.push({
            kind: 'audio',
            timestamp: c.timestamp,
            add: () => muxer.addAudio(c, meta),
          })
        },
        error: onError,
      })
      audioEncoder.configure(audio.encoderConfig)
      encodeAudio(audioEncoder, audio.buffer)
      await audioEncoder.flush()
      audioEncoder.close()
      if (encodeError) throw encodeError
    }
  } finally {
    if (videoEncoder.state !== 'closed') videoEncoder.close()
  }

  // Mux in monotonic timestamp order (stable sort keeps per-track order).
  pending.sort((a, b) => a.timestamp - b.timestamp)
  for (const p of pending) p.add()
  const buffer = muxer.finalize()

  // Streaming target: the bytes are already on disk through `opts.writable`, so
  // just flush and close it. In-memory target: hand the buffer back as a Blob.
  let blob: Blob | null = null
  if (opts.writable) {
    await opts.writable.close()
  } else {
    const mime = opts.format === 'mp4' ? 'video/mp4' : 'video/webm'
    blob = new Blob([buffer as ArrayBuffer], { type: mime })
  }
  return {
    blob,
    filename: exportFilename(opts.format, opts.name),
    width,
    height,
    frames: totalFrames,
    hasAudio: audio !== null,
  }
}

// ---- video codec selection ----

interface ResolvedConfig {
  encoderConfig: VideoEncoderConfig
  muxerCodec: string
}

/** Probe encoder configs from best to most-compatible and return the first the
 *  device actually supports. */
async function pickConfig(
  format: ExportFormat,
  width: number,
  height: number,
  framerate: number,
  bitrate: number,
): Promise<ResolvedConfig> {
  const candidates =
    format === 'mp4'
      ? [
          { codec: 'avc1.640034', muxerCodec: 'avc' }, // High 5.2
          { codec: 'avc1.4d0034', muxerCodec: 'avc' }, // Main 5.2
          { codec: 'avc1.42e01f', muxerCodec: 'avc' }, // Baseline 3.1
          { codec: 'avc1.42001f', muxerCodec: 'avc' },
        ]
      : [
          { codec: 'vp09.00.10.08', muxerCodec: 'V_VP9' },
          { codec: 'vp8', muxerCodec: 'V_VP8' },
        ]

  for (const c of candidates) {
    const cfg: VideoEncoderConfig = { codec: c.codec, width, height, framerate, bitrate }
    try {
      const { supported } = await VideoEncoder.isConfigSupported(cfg)
      if (supported) return { encoderConfig: cfg, muxerCodec: c.muxerCodec }
    } catch {
      // isConfigSupported can throw on malformed codec strings; just try the next.
    }
  }
  throw new Error(
    `No supported ${format.toUpperCase()} encoder on this device. Try the other format.`,
  )
}

// ---- audio preparation ----

interface PreparedAudio {
  buffer: AudioBuffer
  encoderConfig: AudioEncoderConfig
  muxer: { codec: 'aac' | 'opus'; muxerCodec: string; sampleRate: number; channels: number }
}

/** Decode the source audio, resample/down-mix it, and pick an encoder config.
 *  Returns null (video-only export) if there's no usable audio track. */
async function prepareAudio(
  format: ExportFormat,
  video: HTMLVideoElement,
  start: number,
  end: number,
): Promise<PreparedAudio | null> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null
  const url = video.currentSrc || video.src
  if (!url) return null

  let decoded: AudioBuffer | null
  try {
    decoded = await loadAudio(url, AUDIO_SAMPLE_RATE)
  } catch {
    return null
  }
  if (!decoded || decoded.length === 0) return null

  const sampleRate = decoded.sampleRate
  const channels = decoded.numberOfChannels
  const codec = format === 'mp4' ? 'mp4a.40.2' : 'opus' // AAC-LC / Opus
  const encoderConfig: AudioEncoderConfig = {
    codec,
    sampleRate,
    numberOfChannels: channels,
    bitrate: AUDIO_BITRATE,
  }
  try {
    const { supported } = await AudioEncoder.isConfigSupported(encoderConfig)
    if (!supported) return null
  } catch {
    return null
  }

  // Trim the decoded PCM to the export range so audio lines up with video.
  const buffer = sliceAudio(decoded, start, end)
  if (buffer.length === 0) return null

  return {
    buffer,
    encoderConfig,
    muxer: {
      codec: format === 'mp4' ? 'aac' : 'opus',
      muxerCodec: format === 'mp4' ? 'aac' : 'A_OPUS',
      sampleRate,
      channels,
    },
  }
}

/** Fetch + decode the clip's audio, resampled to `targetRate` and ≤2 channels. */
async function loadAudio(url: string, targetRate: number): Promise<AudioBuffer | null> {
  const bytes = await (await fetch(url)).arrayBuffer()
  const Ctx = window.OfflineAudioContext
  if (!Ctx) return null

  // decodeAudioData resamples to the context's sample rate, so decoding in a
  // 48 kHz context usually yields a 48 kHz buffer directly.
  const decoded = await new Ctx(1, 1, targetRate).decodeAudioData(bytes)
  if (decoded.length === 0) return null

  const outChannels = Math.min(2, decoded.numberOfChannels)
  if (decoded.sampleRate === targetRate && decoded.numberOfChannels === outChannels) {
    return decoded
  }

  // Render through a target-rate context to resample and/or down-mix. WebAudio
  // applies its standard channel down-mix when the destination has fewer channels.
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate))
  const rsCtx = new Ctx(outChannels, frames, targetRate)
  const node = rsCtx.createBufferSource()
  node.buffer = decoded
  node.connect(rsCtx.destination)
  node.start()
  return rsCtx.startRendering()
}

/** Return the [start, end] slice of an AudioBuffer as a plain channel store. */
function sliceAudio(buffer: AudioBuffer, start: number, end: number): AudioBuffer {
  const sr = buffer.sampleRate
  const ch = buffer.numberOfChannels
  const startSample = Math.max(0, Math.floor(start * sr))
  const endSample = Math.min(buffer.length, Math.ceil(end * sr))
  const length = Math.max(0, endSample - startSample)
  if (length === buffer.length) return buffer
  // AudioBuffer can't be constructed without a context; reuse a tiny one.
  const ctx = new window.OfflineAudioContext(ch, Math.max(1, length), sr)
  const out = ctx.createBuffer(ch, Math.max(1, length), sr)
  for (let c = 0; c < ch; c++) {
    out.copyToChannel(buffer.getChannelData(c).subarray(startSample, endSample), c)
  }
  return out
}

/** Feed an AudioBuffer to the encoder as planar f32 `AudioData` blocks. */
function encodeAudio(encoder: AudioEncoder, buffer: AudioBuffer): void {
  const sampleRate = buffer.sampleRate
  const channels = buffer.numberOfChannels
  const chans: Float32Array[] = []
  for (let c = 0; c < channels; c++) chans.push(buffer.getChannelData(c))

  const BLOCK = 4800 // 0.1s at 48 kHz
  for (let off = 0; off < buffer.length; off += BLOCK) {
    const frames = Math.min(BLOCK, buffer.length - off)
    const planar = new Float32Array(frames * channels)
    for (let c = 0; c < channels; c++) {
      planar.set(chans[c]!.subarray(off, off + frames), c * frames)
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels: channels,
      timestamp: Math.round((off / sampleRate) * 1e6),
      data: planar,
    })
    encoder.encode(audioData)
    audioData.close()
  }
}

// ---- muxer ----

interface MuxerHandle {
  addVideo: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void
  addAudio: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void
  /** Returns the assembled buffer for an in-memory target, or null when the
   *  output was streamed to a writable (nothing left to hand back). */
  finalize: () => ArrayBuffer | null
}

function createMuxer(
  format: ExportFormat,
  videoCodec: string,
  width: number,
  height: number,
  frameRate: number,
  audio: PreparedAudio['muxer'] | undefined,
  writable: FileSystemWritableFileStream | undefined,
): MuxerHandle {
  if (format === 'mp4') {
    // Streaming to disk writes the moov atom last (`fastStart: false`); the
    // in-memory path keeps `fastStart: 'in-memory'` for web-friendly faststart.
    const target = writable ? new Mp4StreamTarget(writable) : new Mp4Target()
    const muxer = new Mp4Muxer({
      target,
      video: { codec: videoCodec as 'avc' | 'hevc' | 'vp9' | 'av1', width, height, frameRate },
      ...(audio
        ? {
            audio: {
              codec: audio.codec,
              numberOfChannels: audio.channels,
              sampleRate: audio.sampleRate,
            },
          }
        : {}),
      fastStart: writable ? false : 'in-memory',
    })
    return {
      addVideo: (c, m) => muxer.addVideoChunk(c, m),
      addAudio: (c, m) => muxer.addAudioChunk(c, m),
      finalize: () => (muxer.finalize(), writable ? null : (target as Mp4Target).buffer),
    }
  }

  // WebM streams monotonically when `streaming: true`.
  const target = writable ? new WebmStreamTarget(writable) : new WebmTarget()
  const muxer = new WebmMuxer({
    target,
    video: { codec: videoCodec, width, height, frameRate },
    ...(audio
      ? {
          audio: {
            codec: audio.muxerCodec,
            numberOfChannels: audio.channels,
            sampleRate: audio.sampleRate,
          },
        }
      : {}),
    ...(writable ? { streaming: true } : {}),
  })
  return {
    addVideo: (c, m) => muxer.addVideoChunk(c, m),
    addAudio: (c, m) => muxer.addAudioChunk(c, m),
    finalize: () => (muxer.finalize(), writable ? null : (target as WebmTarget).buffer),
  }
}

// ---- frame stepping helpers ----

/** Pixels read back from the engine for one frame. */
type GpuFrame = Awaited<ReturnType<Engine['readFrame']>>

/** Build an even-sized VideoFrame from raw GPU pixels, cropping by ≤1px if the
 *  source dimensions are odd. */
function toVideoFrame(
  data: NonNullable<GpuFrame>,
  dstW: number,
  dstH: number,
  timestamp: number,
  duration: number,
): VideoFrame {
  const { data: pixels, format, width: srcW, height: srcH } = data
  let buffer: Uint8ClampedArray = pixels
  let codedWidth = srcW
  let codedHeight = srcH
  if (srcW !== dstW || srcH !== dstH) {
    const out = new Uint8ClampedArray(dstW * dstH * 4)
    const rows = Math.min(srcH, dstH)
    for (let y = 0; y < rows; y++) {
      out.set(pixels.subarray(y * srcW * 4, y * srcW * 4 + dstW * 4), y * dstW * 4)
    }
    buffer = out
    codedWidth = dstW
    codedHeight = dstH
  }
  return new VideoFrame(buffer, {
    format: format as VideoPixelFormat,
    codedWidth,
    codedHeight,
    timestamp,
    duration,
  })
}

/** Seek the element to `t` and resolve once the frame at that time is presented. */
function seekAndPresent(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    // One rAF gives the compositor a chance to present the decoded frame before
    // the engine imports it. (rVFC isn't reliable while the element is paused.)
    const present = () => requestAnimationFrame(() => resolve())
    if (Math.abs(video.currentTime - t) < 1e-4) {
      present()
      return
    }
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked)
      present()
    }
    video.addEventListener('seeked', onSeeked)
    try {
      video.currentTime = t
    } catch {
      video.removeEventListener('seeked', onSeeked)
      present()
    }
  })
}

function nextRaf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/** Resolve when the encoder drains a chunk (or after a short fallback timeout). */
function onceDequeue(encoder: VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    // Whichever fires first wins; it unregisters the other, so resolve runs once.
    const done = () => {
      encoder.removeEventListener('dequeue', done)
      clearTimeout(timer)
      // oxlint-disable-next-line promise/no-multiple-resolved -- single fire: `done` removes both triggers before resolving
      resolve()
    }
    const timer = setTimeout(done, 50)
    encoder.addEventListener('dequeue', done)
  })
}

function clampFps(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 30
  // Keep fractional rates (23.976, 29.97) intact — frame timestamps are derived
  // from this, so honoring the true source rate avoids speed drift.
  return Math.min(120, Math.max(1, fps))
}

function sanitizeName(name?: string): string {
  if (!name) return ''
  return name
    .replace(/\.[^.]+$/, '') // drop extension
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
}
