import { useEffect, useRef, useState } from 'react'
import { useEditor } from '../../editor/store'
import { cn } from '../../lib/utils'

type ScopeMode = 'histogram' | 'waveform' | 'vectorscope'

const MODES: { id: ScopeMode; label: string }[] = [
  { id: 'histogram', label: 'Histogram' },
  { id: 'waveform', label: 'Parade' },
  { id: 'vectorscope', label: 'Vectorscope' },
]

// Downsampled source resolution we read the viewer canvas into.
const SW = 320
const SH = 180
// Scope output resolution.
const OW = 512
const OH = 256

/**
 * Video scopes — reads the viewer's processed output each frame and draws a
 * histogram (RGB distribution), a luma waveform (the "oscilloscope"), and a
 * vectorscope (chroma scatter), like Resolve / CapCut.
 */
export function Scopes() {
  const canvas = useEditor((s) => s.canvas)
  const [mode, setMode] = useState<ScopeMode>('waveform')
  const outRef = useRef<HTMLCanvasElement>(null)
  // Read the live canvas + mode from refs so a single persistent loop always
  // picks up the latest values — switching modes no longer re-inits the loop,
  // and the parade can't get stuck blank waiting on a stale closure.
  const canvasRef = useRef(canvas)
  canvasRef.current = canvas
  const modeRef = useRef(mode)
  modeRef.current = mode

  useEffect(() => {
    const out = outRef.current
    if (!out) return undefined
    const octx = out.getContext('2d', { willReadFrequently: true })
    if (!octx) return undefined
    const sample = document.createElement('canvas')
    sample.width = SW
    sample.height = SH
    const sctx = sample.getContext('2d', { willReadFrequently: true })
    if (!sctx) return undefined

    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = canvasRef.current
      if (!c || c.width === 0) {
        octx.fillStyle = '#0a0a0a'
        octx.fillRect(0, 0, OW, OH)
        return
      }
      try {
        sctx.drawImage(c, 0, 0, SW, SH)
      } catch {
        return
      }
      const { data } = sctx.getImageData(0, 0, SW, SH)
      const m = modeRef.current
      if (m === 'histogram') drawHistogram(octx, data)
      else if (m === 'waveform') drawParade(octx, data)
      else drawVectorscope(octx, data)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMode(m.id)}
            className={cn(
              'rounded px-2 py-1 text-[11px] transition-colors',
              mode === m.id
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        <canvas
          ref={outRef}
          width={OW}
          height={OH}
          className="h-full max-h-full w-full max-w-full rounded-sm bg-[#0a0a0a] object-contain"
        />
      </div>
    </div>
  )
}

function drawHistogram(ctx: CanvasRenderingContext2D, data: Uint8ClampedArray) {
  const r = new Float32Array(256)
  const g = new Float32Array(256)
  const b = new Float32Array(256)
  for (let i = 0; i < data.length; i += 4) {
    const ri = data[i]
    const gi = data[i + 1]
    const bi = data[i + 2]
    if (ri === undefined || gi === undefined || bi === undefined) continue
    r[ri] = (r[ri] ?? 0) + 1
    g[gi] = (g[gi] ?? 0) + 1
    b[bi] = (b[bi] ?? 0) + 1
  }
  let max = 1
  for (let i = 1; i < 255; i++) max = Math.max(max, r[i] ?? 0, g[i] ?? 0, b[i] ?? 0)

  ctx.fillStyle = '#0a0a0a'
  ctx.fillRect(0, 0, OW, OH)
  drawGrid(ctx)

  ctx.globalCompositeOperation = 'lighter'
  const plot = (bins: Float32Array, color: string) => {
    ctx.beginPath()
    ctx.moveTo(0, OH)
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * OW
      const y = OH - Math.min(1, (bins[i] ?? 0) / max) * (OH - 4)
      ctx.lineTo(x, y)
    }
    ctx.lineTo(OW, OH)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  }
  plot(r, 'rgba(255,64,64,0.55)')
  plot(g, 'rgba(64,255,64,0.55)')
  plot(b, 'rgba(80,120,255,0.6)')
  ctx.globalCompositeOperation = 'source-over'
}

// RGB Parade — R, G, B waveforms side by side (the DaVinci default).
const PARADE_COLORS: [number, number, number][] = [
  [255, 80, 80],
  [90, 255, 110],
  [100, 150, 255],
]

function drawParade(ctx: CanvasRenderingContext2D, data: Uint8ClampedArray) {
  const third = Math.floor(OW / 3)
  const accs = [new Float32Array(OW * OH), new Float32Array(OW * OH), new Float32Array(OW * OH)]
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const i = (y * SW + x) * 4
      const tx = ((x / (SW - 1)) * (third - 1)) | 0
      for (let ch = 0; ch < 3; ch++) {
        const accCh = accs[ch]
        if (!accCh) continue
        const v = (data[i + ch] ?? 0) / 255
        const ox = ch * third + tx
        const oy = ((1 - v) * (OH - 1)) | 0
        const idx = oy * OW + ox
        accCh[idx] = (accCh[idx] ?? 0) + 1
      }
    }
  }

  ctx.fillStyle = '#0a0a0a'
  ctx.fillRect(0, 0, OW, OH)
  drawGrid(ctx)
  const img = ctx.getImageData(0, 0, OW, OH)
  const px = img.data
  for (let ch = 0; ch < 3; ch++) {
    const acc = accs[ch]
    const color = PARADE_COLORS[ch]
    if (!acc || !color) continue
    const [cr, cg, cb] = color
    let max = 1
    for (let i = 0; i < acc.length; i++) {
      const a = acc[i]
      if (a !== undefined && a > max) max = a
    }
    const norm = 1 / Math.log1p(max)
    for (let i = 0; i < acc.length; i++) {
      const v = acc[i]
      if (v === undefined || v === 0) continue
      const a = Math.min(1, Math.log1p(v) * norm * 2.2)
      const o = i * 4
      const p0 = px[o]
      const p1 = px[o + 1]
      const p2 = px[o + 2]
      if (p0 === undefined || p1 === undefined || p2 === undefined) continue
      px[o] = Math.min(255, p0 + cr * a)
      px[o + 1] = Math.min(255, p1 + cg * a)
      px[o + 2] = Math.min(255, p2 + cb * a)
      px[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  ctx.strokeStyle = 'rgba(255,255,255,0.1)'
  ctx.beginPath()
  ctx.moveTo(third, 0)
  ctx.lineTo(third, OH)
  ctx.moveTo(2 * third, 0)
  ctx.lineTo(2 * third, OH)
  ctx.stroke()

  drawLevelScale(ctx)
}

// 10-bit code-value scale (0..1023) up the left edge so you can read how close
// the signal is to clipping.
function drawLevelScale(ctx: CanvasRenderingContext2D) {
  const levels = [1023, 768, 512, 256, 0]
  ctx.font = '9px ui-monospace, monospace'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  for (const v of levels) {
    const y = Math.max(6, Math.min(OH - 6, (1 - v / 1023) * OH))
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.beginPath()
    ctx.moveTo(22, y)
    ctx.lineTo(OW, y)
    ctx.stroke()
    ctx.fillStyle = 'rgba(0,0,0,0.65)'
    ctx.fillRect(0, y - 6, 21, 12)
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.fillText(String(v), 1, y + 0.5)
  }
}

function drawVectorscope(ctx: CanvasRenderingContext2D, data: Uint8ClampedArray) {
  const acc = new Float32Array(OW * OH)
  const cx = OW / 2
  const cy = OH / 2
  const scale = OH * 0.9 // 0.5 chroma maps near the edge
  for (let i = 0; i < data.length; i += 4) {
    const rr = (data[i] ?? 0) / 255
    const gg = (data[i + 1] ?? 0) / 255
    const bb = (data[i + 2] ?? 0) / 255
    const cb = -0.168736 * rr - 0.331264 * gg + 0.5 * bb
    const cr = 0.5 * rr - 0.418688 * gg - 0.081312 * bb
    const ox = (cx + cb * scale) | 0
    const oy = (cy - cr * scale) | 0
    if (ox >= 0 && ox < OW && oy >= 0 && oy < OH) {
      const idx = oy * OW + ox
      acc[idx] = (acc[idx] ?? 0) + 1
    }
  }
  ctx.fillStyle = '#0a0a0a'
  ctx.fillRect(0, 0, OW, OH)
  // graticule
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.beginPath()
  ctx.arc(cx, cy, OH * 0.45, 0, Math.PI * 2)
  ctx.moveTo(cx - OH * 0.45, cy)
  ctx.lineTo(cx + OH * 0.45, cy)
  ctx.moveTo(cx, cy - OH * 0.45)
  ctx.lineTo(cx, cy + OH * 0.45)
  ctx.stroke()
  renderIntensity(ctx, acc, [180, 255, 180], false)
}

/** Map an accumulation buffer to a glowing monochrome image and blit it. */
function renderIntensity(
  ctx: CanvasRenderingContext2D,
  acc: Float32Array,
  [cr, cg, cb]: [number, number, number],
  clear = true,
) {
  if (clear) {
    ctx.fillStyle = '#0a0a0a'
    ctx.fillRect(0, 0, OW, OH)
    drawGrid(ctx)
  }
  let max = 1
  for (let i = 0; i < acc.length; i++) {
    const a = acc[i]
    if (a !== undefined && a > max) max = a
  }
  const img = ctx.getImageData(0, 0, OW, OH)
  const px = img.data
  const norm = 1 / Math.log1p(max)
  for (let i = 0; i < acc.length; i++) {
    const v = acc[i]
    if (v === undefined || v === 0) continue
    const a = Math.min(1, Math.log1p(v) * norm * 2.2)
    const o = i * 4
    const p0 = px[o]
    const p1 = px[o + 1]
    const p2 = px[o + 2]
    if (p0 === undefined || p1 === undefined || p2 === undefined) continue
    px[o] = Math.min(255, p0 + cr * a)
    px[o + 1] = Math.min(255, p1 + cg * a)
    px[o + 2] = Math.min(255, p2 + cb * a)
    px[o + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
}

function drawGrid(ctx: CanvasRenderingContext2D) {
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 1; i < 4; i++) {
    const y = (OH / 4) * i
    ctx.moveTo(0, y)
    ctx.lineTo(OW, y)
  }
  ctx.stroke()
}
