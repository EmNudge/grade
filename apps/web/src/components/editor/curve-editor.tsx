import { useEffect, useRef, useState } from 'react'
import { CURVE_MAX } from '@grade/nodes'
import { RotateCcw } from 'lucide-react'
import { Slider } from '../../components/ui/slider'
import { type NodeValues, useEditor } from '../../editor/store'
import { cn } from '../../lib/utils'

// The shader's per-curve control-point cap (x0..x{N-1}); kept in lockstep by
// importing the same constant the kernel is generated from.
const MAX = CURVE_MAX

// viewBox is 2:1 (wide) so there's room to place points horizontally. It MUST
// match the element's CSS aspect ratio: with preserveAspectRatio="none" the box
// is scaled to fill, and only an equal x/y scale keeps the point handles round.
// x spans 0..VBW, y spans 0..VBH; normalised point coords (0..1) map onto these.
const VBW = 200
const VBH = 100
// Tone curves: x = input level, y = output level (identity by default).
const CHANNELS = [
  { id: 'm', label: 'Y', color: '#e5e5e5' },
  { id: 'r', label: 'R', color: '#ff5a5a' },
  { id: 'g', label: 'G', color: '#5aff7d' },
  { id: 'b', label: 'B', color: '#6aa8ff' },
] as const

// Hue curves (DaVinci-style): x = pixel hue, y centred at 0.5 = neutral. They
// rotate hue, scale saturation, or scale luminance per source hue.
const HUE_CURVES = [
  { id: 'hh', label: 'Hue→Hue', color: '#e5e5e5' },
  { id: 'hs', label: 'Hue→Sat', color: '#e5e5e5' },
  { id: 'hl', label: 'Hue→Lum', color: '#e5e5e5' },
] as const

// Y-based and saturation-based curves. These use the same `crv*_n` / `crv*_*i`
// storage as hue curves, but the x-axis is luma or saturation instead of hue.
const LUMA_CURVES = [{ id: 'ls', label: 'Lum→Sat', color: '#e5e5e5' }] as const

const SAT_CURVES = [
  { id: 'ss', label: 'Sat→Sat', color: '#e5e5e5' },
  { id: 'sl', label: 'Sat→Lum', color: '#e5e5e5' },
] as const

const ALL_CHANNELS = [...CHANNELS, ...HUE_CURVES, ...LUMA_CURVES, ...SAT_CURVES]
type Ch = (typeof ALL_CHANNELS)[number]['id']
const isHueCh = (ch: Ch): boolean =>
  ch === 'hh' || ch === 'hs' || ch === 'hl' || ch === 'ls' || ch === 'ss' || ch === 'sl'

// Rainbow stops for the hue-curve x-axis backdrop (red→…→red, one turn).
const HUE_STOPS = ['#ff5a5a', '#ffd25a', '#5aff7d', '#5affff', '#5a7dff', '#d25aff', '#ff5a5a']

// Greyscale stops for the lum/sat x-axis backdrops.
const LUM_STOPS = ['#000000', '#404040', '#808080', '#bfbfbf', '#ffffff']
interface Pt {
  x: number
  y: number
}

function num(v: unknown, fallback: number) {
  return typeof v === 'number' ? v : fallback
}

// Analysis resolution + poll cadence for the upstream histogram backdrop.
const HIST_W = 256
const HIST_H = 144
const HIST_INTERVAL_MS = 100

interface Frame {
  data: Uint8ClampedArray
  format: 'RGBA' | 'BGRA'
}

// Where the background histogram samples the signal (or off entirely).
type HistMode = 'input' | 'output' | 'off'
const HIST_LABEL: Record<HistMode, string> = {
  input: 'Hist: In',
  output: 'Hist: Out',
  off: 'Hist: Off',
}

interface RgbHist {
  r: number[]
  g: number[]
  b: number[]
}

/**
 * 256-bin R/G/B distributions of a frame, colour-separated (DaVinci-style) so
 * casts are visible rather than a flat grey luma blob. All three share one
 * normalisation (the tallest interior bin across channels) so their heights stay
 * comparable.
 */
function histogramRGB(frame: Frame): RgbHist {
  const { data } = frame
  const bgra = frame.format === 'BGRA'
  const r = new Float32Array(256)
  const g = new Float32Array(256)
  const b = new Float32Array(256)
  for (let i = 0; i < data.length; i += 4) {
    const rv = data[bgra ? i + 2 : i] ?? 0
    const gv = data[i + 1] ?? 0
    const bv = data[bgra ? i : i + 2] ?? 0
    r[rv] = (r[rv] ?? 0) + 1
    g[gv] = (g[gv] ?? 0) + 1
    b[bv] = (b[bv] ?? 0) + 1
  }
  let max = 1
  for (let i = 1; i < 255; i++) max = Math.max(max, r[i] ?? 0, g[i] ?? 0, b[i] ?? 0)
  const norm = (bins: Float32Array) => Array.from(bins, (c) => Math.min(1, c / max))
  return { r: norm(r), g: norm(g), b: norm(b) }
}

/**
 * Hue of an 8-bit RGB triple as a 0..1 turn, or null when the pixel is too close
 * to neutral for its hue to mean anything (grays would otherwise pile onto red).
 */
function rgbToHue(r: number, g: number, b: number): number | null {
  const mx = Math.max(r, g, b)
  const d = mx - Math.min(r, g, b)
  if (d < 8) return null // < ~3% chroma — effectively neutral
  let h: number
  if (mx === r) h = ((g - b) / d) % 6
  else if (mx === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h /= 6
  return h < 0 ? h + 1 : h
}

/**
 * Luma (0..1) of an 8-bit RGB triple using Rec.709 weights.
 */
function rgbToLuma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/**
 * Saturation (0..1) of an 8-bit RGB triple — chroma / max.
 */
function rgbToSat(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const d = mx - mn
  return mx > 0 ? d / mx : 0
}

/**
 * 256-bin hue distribution of a frame, each pixel weighted by its chroma so
 * vivid colours read louder than washed-out ones. Normalised to its own peak.
 * Drawn behind the hue curves as an x = hue backdrop.
 */
function histogramHue(frame: Frame): number[] {
  const { data } = frame
  const bgra = frame.format === 'BGRA'
  const bins = new Float32Array(256)
  for (let i = 0; i < data.length; i += 4) {
    const r = data[bgra ? i + 2 : i] ?? 0
    const g = data[i + 1] ?? 0
    const b = data[bgra ? i : i + 2] ?? 0
    const h = rgbToHue(r, g, b)
    if (h === null) continue
    const bin = Math.min(255, Math.floor(h * 256))
    bins[bin] = (bins[bin] ?? 0) + (Math.max(r, g, b) - Math.min(r, g, b)) / 255
  }
  let max = 1
  for (let i = 0; i < 256; i++) max = Math.max(max, bins[i] ?? 0)
  return Array.from(bins, (c) => Math.min(1, c / max))
}

function histogramLuma(frame: Frame): number[] {
  const { data } = frame
  const bgra = frame.format === 'BGRA'
  const bins = new Float32Array(256)
  for (let i = 0; i < data.length; i += 4) {
    const r = data[bgra ? i + 2 : i] ?? 0
    const g = data[i + 1] ?? 0
    const b = data[bgra ? i : i + 2] ?? 0
    const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
    bins[luma] = (bins[luma] ?? 0) + 1
  }
  let max = 1
  for (let i = 0; i < 256; i++) max = Math.max(max, bins[i] ?? 0)
  return Array.from(bins, (c) => Math.min(1, c / max))
}

function histogramSat(frame: Frame): number[] {
  const { data } = frame
  const bgra = frame.format === 'BGRA'
  const bins = new Float32Array(256)
  for (let i = 0; i < data.length; i += 4) {
    const r = data[bgra ? i + 2 : i] ?? 0
    const g = data[i + 1] ?? 0
    const b = data[bgra ? i : i + 2] ?? 0
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const d = mx - mn
    const sat = mx > 0 ? Math.round((d / mx) * 255) : 0
    bins[sat] = (bins[sat] ?? 0) + 1
  }
  let max = 1
  for (let i = 0; i < 256; i++) max = Math.max(max, bins[i] ?? 0)
  return Array.from(bins, (c) => Math.min(1, c / max))
}

// Mirrors the shader's grade_curveN: linear, or Catmull-Rom when smooth.
function evalCurve(x: number, pts: Pt[], smooth: boolean): number {
  const n = pts.length
  const at = (i: number): Pt => pts[Math.max(0, Math.min(n - 1, i))] ?? { x: 0, y: 0 }
  const xc = Math.min(1, Math.max(0, x))
  if (xc <= at(0).x) return at(0).y
  for (let i = 0; i < n - 1; i++) {
    const a = at(i)
    const b = at(i + 1)
    if (xc <= b.x) {
      const t = (xc - a.x) / Math.max(b.x - a.x, 1e-5)
      if (smooth) {
        const p1 = a.y
        const p2 = b.y
        // Reflect the phantom points at the ends (instead of clamping to the
        // endpoint) so the end tangents equal the segment's own secant. That
        // keeps a 2-point spline — and any point left on the line — perfectly
        // straight; curvature only appears once an interior point is moved off.
        const p0 = i - 1 >= 0 ? at(i - 1).y : 2 * p1 - p2
        const p3 = i + 2 <= n - 1 ? at(i + 2).y : 2 * p2 - p1
        const t2 = t * t
        const t3 = t2 * t
        // Reduced-tension Catmull-Rom (tension 0.5 → tangents halved) in
        // Hermite form so the curve stays smooth without overshooting.
        const m0 = (p2 - p0) * 0.25
        const m1 = (p3 - p1) * 0.25
        return (
          p1 * (2 * t3 - 3 * t2 + 1) +
          m0 * (t3 - 2 * t2 + t) +
          p2 * (-2 * t3 + 3 * t2) +
          m1 * (t3 - t2)
        )
      }
      return a.y + (b.y - a.y) * t
    }
  }
  return at(n - 1).y
}

/**
 * Per-channel tone-curve editor. Default is a straight line with start/end
 * points only; click to add a point, drag to shape, double-click an interior
 * point to remove. Linear interpolation — matches the shader's grade_curveN.
 */
export function CurveEditor({
  values,
  onChange,
  histogramSource,
}: {
  values: NodeValues
  onChange: (patch: NodeValues) => void
  /** Compiled pass id (`${nodeId}:${fxId}`) whose input feeds the histogram. */
  histogramSource?: string
}) {
  const [ch, setCh] = useState<Ch>('m')
  const svgRef = useRef<SVGSVGElement>(null)
  const dragIndex = useRef<number | null>(null)
  const dragCeil = useRef<'top' | 'bottom' | null>(null)
  const color = ALL_CHANNELS.find((c) => c.id === ch)!.color
  const isHue = isHueCh(ch)
  // Hue curves are always splined (DaVinci-style). With the reflected end
  // tangents a flat or 2-point hue curve still reads as a straight line, so this
  // only rounds off real bends. Tone curves follow the shared Spline toggle.
  const smooth = isHue ? true : Boolean(values['crv_smooth'])
  // White ceiling (the top notch): remaps the curve output into [floor, ceil] =
  // [1-wht, wht], so dropping the ceiling raises the floor by the same amount.
  // Tone curves only. `span` is kept >0 for the inverse used while dragging.
  const wht = isHue ? 1 : num(values[`crv${ch}_wht`], 1)
  const floor = 1 - wht
  const span = wht - floor
  const spanSafe = Math.max(span, 1e-3)
  // raw curve y (0..1) <-> screen-normalised output (0 = bottom, 1 = top).
  const toScreenY = (rawY: number) => (1 - (floor + rawY * span)) * VBH
  const toRawY = (outNorm: number) => (outNorm - floor) / spanSafe

  // Signal distribution drawn behind the grid, colour-separated. Configurable to
  // sample the curve's input (pre-grade) or output (post-grade), or be turned
  // off, since the histogram only applies to the tone curves (not hue curves).
  const engine = useEditor((s) => s.engine)
  const [histMode, setHistMode] = useState<HistMode>('input')
  const [hist, setHist] = useState<RgbHist | null>(null)
  // Hue curves get a hue-distribution backdrop (which hues are present) rather
  // than the tone curves' R/G/B levels, so you can see what you're editing.
  const [hueHist, setHueHist] = useState<number[] | null>(null)
  const [lumaHist, setLumaHist] = useState<number[] | null>(null)
  const [satHist, setSatHist] = useState<number[] | null>(null)
  const [activePt, setActivePt] = useState<number | null>(null)
  const histOn = histMode !== 'off'

  useEffect(() => {
    if (!engine || !histogramSource || !histOn) {
      setHist(null)
      setHueHist(null)
      setLumaHist(null)
      setSatHist(null)
      return undefined
    }
    engine.setHistogramSource(histogramSource, histMode === 'output' ? 'output' : 'input')
    const live = { current: true }
    let busy = false
    let timer = 0
    const tick = async () => {
      if (!live.current) return
      if (!busy) {
        busy = true
        try {
          const frame = await engine.sampleNodeInput(HIST_W, HIST_H)
          if (live.current) {
            if (ch === 'hh' || ch === 'hs' || ch === 'hl') {
              setHueHist(frame ? histogramHue(frame) : null)
              setHist(null)
              setLumaHist(null)
              setSatHist(null)
            } else if (ch === 'ls') {
              setLumaHist(frame ? histogramLuma(frame) : null)
              setHueHist(null)
              setHist(null)
              setSatHist(null)
            } else if (ch === 'ss' || ch === 'sl') {
              setSatHist(frame ? histogramSat(frame) : null)
              setHueHist(null)
              setHist(null)
              setLumaHist(null)
            } else {
              setHist(frame ? histogramRGB(frame) : null)
              setHueHist(null)
              setLumaHist(null)
              setSatHist(null)
            }
          }
        } catch {
          /* readback hiccup — keep the last histogram */
        }
        busy = false
      }
      timer = window.setTimeout(() => void tick(), HIST_INTERVAL_MS)
    }
    void tick()
    return () => {
      live.current = false
      window.clearTimeout(timer)
      engine.setHistogramSource(null)
    }
  }, [engine, histogramSource, histMode, histOn, ch])

  // Filled area under a channel's (normalised) bins, in the viewBox; bottom-anchored.
  const histPoly = (bins: number[]) =>
    `0,${VBH} ${bins
      .map((v, i) => `${((i / 255) * VBW).toFixed(2)},${(VBH - v * (VBH * 0.9)).toFixed(2)}`)
      .join(' ')} ${VBW},${VBH}`

  // Neutral default per channel: tone curves are an identity ramp (0,0)->(1,1);
  // hue curves sit flat at y=0.5 (no shift / ×1).
  const defY = (i: number) => (isHue ? 0.5 : i === 0 ? 0 : 1)
  const count = Math.round(num(values[`crv${ch}_n`], 2))
  const pts: Pt[] = Array.from({ length: count }, (_, i) => ({
    x: num(values[`crv${ch}_x${i}`], i === 0 ? 0 : 1),
    y: num(values[`crv${ch}_y${i}`], defY(i)),
  }))

  const round = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000

  // Write a full (sorted) point set back into the flat params.
  const writePts = (next: Pt[]) => {
    const sorted = next.toSorted((a, b) => a.x - b.x)
    const patch: NodeValues = { [`crv${ch}_n`]: sorted.length }
    for (let i = 0; i < MAX; i++) {
      const p = sorted[Math.min(i, sorted.length - 1)]
      patch[`crv${ch}_x${i}`] = i < sorted.length && p ? round(p.x) : 1
      patch[`crv${ch}_y${i}`] = p ? round(p.y) : 1
    }
    onChange(patch)
  }

  const fromEvent = (clientX: number, clientY: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect()
    return {
      x: (clientX - r.left) / r.width,
      y: 1 - (clientY - r.top) / r.height,
    }
  }

  // Drag an existing point. Endpoints can slide inward (start later / end
  // earlier, DaVinci-style) but stay pinned to the 0 / 1 edges — the shader
  // (and evalCurve) hold the curve flat at the endpoint's y beyond it.
  const dragPoint = (clientX: number, clientY: number) => {
    const i = dragIndex.current
    if (i === null) return
    const p = fromEvent(clientX, clientY)
    p.y = toRawY(p.y) // undo the ceiling remap so handles track the cursor
    const next = pts.map((q) => ({ ...q }))
    if (i === 0) {
      const nextPt = next[1]
      const hi = nextPt ? nextPt.x - 0.005 : 1
      next[0] = { x: round(Math.max(0, Math.min(hi, p.x))), y: round(p.y) }
    } else if (i === count - 1) {
      const prev = next[count - 2]
      const lo = prev ? prev.x + 0.005 : 0
      next[count - 1] = { x: round(Math.max(lo, Math.min(1, p.x))), y: round(p.y) }
    } else {
      const prev = next[i - 1]
      const nextPt = next[i + 1]
      if (!prev || !nextPt) return
      const lo = prev.x + 0.005
      const hi = nextPt.x - 0.005
      next[i] = { x: round(Math.max(lo, Math.min(hi, p.x))), y: round(p.y) }
    }
    // Write directly (preserve index order — no re-sort while dragging).
    const patch: NodeValues = {}
    next.forEach((q, k) => {
      patch[`crv${ch}_x${k}`] = q.x
      patch[`crv${ch}_y${k}`] = q.y
    })
    onChange(patch)
  }

  const removePoint = (i: number) => {
    if (i === 0 || i === count - 1 || count <= 2) return
    writePts(pts.filter((_, k) => k !== i))
    if (activePt === i) setActivePt(null)
    else if (activePt !== null && activePt > i) setActivePt(activePt - 1)
  }

  const reset = () => {
    setActivePt(null)
    if (!isHue) onChange({ [`crv${ch}_wht`]: 1 })
    writePts(
      isHue
        ? [
            { x: 0, y: 0.5 },
            { x: 1, y: 0.5 },
          ]
        : [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
    )
  }

  // Eyedropper: while a curve tab is open, the Viewer lets you click the image to
  // drop control points at the pixel's x-axis value (hue, luma, or saturation).
  // Adds three points: one at the picked value (y = 0.5 = neutral) and one a
  // small step to each side, so you get a visible notch and two drag handles.
  const PICK_OFFSET = 0.04
  const addPickedPoint = (rgb: [number, number, number]) => {
    if (count + 2 > MAX) return // need room for up to 3 points
    const [r, g, b] = rgb
    let nx: number | null = null
    if (ch === 'hh' || ch === 'hs' || ch === 'hl') {
      nx = rgbToHue(r, g, b)
    } else if (ch === 'ls') {
      nx = rgbToLuma(r, g, b)
    } else if (ch === 'ss' || ch === 'sl') {
      nx = rgbToSat(r, g, b)
    }
    if (nx === null) return
    // Build three points: left, center, right (clamped to [0, 1]). Skip a side
    // if it would coincide with the centre (e.g. when the pick lands on 0 or 1).
    const lo = round(Math.max(0, nx - PICK_OFFSET))
    const mid = round(nx)
    const hi = round(Math.min(1, nx + PICK_OFFSET))
    const add: Pt[] = []
    if (lo < mid) add.push({ x: lo, y: 0.5 })
    if (!add.some((p) => Math.abs(p.x - mid) < 0.005)) add.push({ x: mid, y: 0.5 })
    if (hi > mid && !add.some((p) => Math.abs(p.x - hi) < 0.005)) add.push({ x: hi, y: 0.5 })
    // Skip if all proposed positions already have a point nearby.
    const all = [...pts, ...add]
    if (add.every((p) => pts.some((q) => Math.abs(q.x - p.x) < 0.02))) return
    writePts(all)
  }
  const setEyedropPick = useEditor((s) => s.setEyedropPick)
  // Keep a live ref so the registered picker always sees the current points,
  // without re-registering (and re-rendering the Viewer) on every edit.
  const pickRef = useRef(addPickedPoint)
  pickRef.current = addPickedPoint
  useEffect(() => {
    if (!isHue) return undefined
    setEyedropPick((rgb) => pickRef.current(rgb))
    return () => setEyedropPick(null)
  }, [isHue, setEyedropPick])

  // Clear the active-point selection when switching channels.
  useEffect(() => {
    setActivePt(null)
  }, [ch])

  // Sample the (possibly splined) curve for the polyline, remapped by the ceiling.
  const line = Array.from({ length: 65 }, (_, k) => {
    const x = k / 64
    return `${(x * VBW).toFixed(2)},${toScreenY(evalCurve(x, pts, smooth)).toFixed(2)}`
  }).join(' ')

  // Symmetric ceiling/floor notches. The top notch sets the ceiling (wht); the
  // bottom notch sets the floor (1-wht). Both clamp to [0.5, 1] so the range
  // never inverts. ceilY/floorY are mirror images around the mid-line.
  const ceilY = floor * VBH // screen y of the ceiling (out = wht)
  const floorY = wht * VBH // screen y of the floor (out = 1-wht)
  const setCeiling = (c: number) =>
    onChange({ [`crv${ch}_wht`]: round(Math.min(1, Math.max(0.5, c))) })
  const setCeil = (clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect()
    setCeiling(1 - (clientY - r.top) / r.height)
  }
  const setFloor = (clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect()
    setCeiling((clientY - r.top) / r.height) // floor rises -> ceiling = 1 - floor
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-y-1">
        <div className="flex flex-wrap items-center gap-1">
          {CHANNELS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCh(c.id)}
              className={cn(
                'size-6 rounded text-[11px] font-medium transition-colors',
                ch === c.id ? 'bg-muted' : 'text-muted-foreground hover:text-foreground',
              )}
              style={ch === c.id ? { color: c.color } : undefined}
            >
              {c.label}
            </button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-border" />
          {HUE_CURVES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCh(c.id)}
              className={cn(
                'rounded px-1.5 py-1 text-[11px] font-medium transition-colors',
                ch === c.id
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {c.label}
            </button>
          ))}
          {LUMA_CURVES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCh(c.id)}
              className={cn(
                'rounded px-1.5 py-1 text-[11px] font-medium transition-colors',
                ch === c.id
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {c.label}
            </button>
          ))}
          {SAT_CURVES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCh(c.id)}
              className={cn(
                'rounded px-1.5 py-1 text-[11px] font-medium transition-colors',
                ch === c.id
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() =>
              setHistMode((m) => (m === 'input' ? 'output' : m === 'output' ? 'off' : 'input'))
            }
            className={cn(
              'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
              histMode !== 'off'
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            title="Histogram source: input → output → off"
          >
            {HIST_LABEL[histMode]}
          </button>
          {/* Hue curves are always splined, so the toggle only applies to tone. */}
          {!isHue && (
            <button
              type="button"
              onClick={() => onChange({ crv_smooth: !smooth })}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                smooth ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
              title="Toggle spline (smooth) interpolation"
            >
              Spline
            </button>
          )}
          <button
            type="button"
            onClick={reset}
            className="text-muted-foreground transition-colors hover:text-foreground"
            title="Reset curve to linear"
          >
            <RotateCcw className="size-3.5" />
          </button>
        </div>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${VBW} ${VBH}`}
        preserveAspectRatio="none"
        className="aspect-[2/1] w-full max-w-[400px] touch-none overflow-visible rounded-md border border-border bg-[#0d0d0d]"
        onPointerDown={(e) => {
          // Grabbing a handle stops propagation (see the circles below), so any
          // pointerdown that reaches the svg is on empty space: add a point and
          // immediately start dragging it. (Don't gate on e.target — clicks that
          // land on the grid/curve/histogram should add too, not be rejected.)
          setActivePt(null)
          if (e.button !== 0 || count >= MAX) return
          const p = fromEvent(e.clientX, e.clientY)
          const nx = round(p.x)
          dragIndex.current = pts.filter((q) => q.x < nx).length
          writePts([...pts, { x: nx, y: round(toRawY(p.y)) }])
          svgRef.current?.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (dragCeil.current === 'top') setCeil(e.clientY)
          else if (dragCeil.current === 'bottom') setFloor(e.clientY)
          else if (dragIndex.current !== null) dragPoint(e.clientX, e.clientY)
        }}
        onPointerUp={(e) => {
          dragIndex.current = null
          dragCeil.current = null
          svgRef.current?.releasePointerCapture(e.pointerId)
        }}
      >
        {/* Decorative layers ignore pointer events so the draggable handles
            below are the only interactive children; clicks anywhere else fall
            through to the svg's onPointerDown and add a point. */}
        {/* Hue curves get a rainbow x-axis strip; lum/sat curves get greyscale; tone curves get RGB histogram. */}
        {ch === 'hh' || ch === 'hs' || ch === 'hl' ? (
          <>
            <defs>
              <linearGradient id="hue-axis" x1="0" y1="0" x2="1" y2="0">
                {HUE_STOPS.map((c, i) => {
                  const offset = `${(i / (HUE_STOPS.length - 1)) * 100}%`
                  return <stop key={offset} offset={offset} stopColor={c} />
                })}
              </linearGradient>
            </defs>
            <rect
              x={0}
              y={0}
              width={VBW}
              height={VBH}
              fill="url(#hue-axis)"
              opacity={0.14}
              pointerEvents="none"
            />
            {hueHist && (
              <polygon
                points={histPoly(hueHist)}
                fill="rgba(255,255,255,0.22)"
                stroke="none"
                pointerEvents="none"
              />
            )}
          </>
        ) : ch === 'ls' || ch === 'ss' || ch === 'sl' ? (
          <>
            <defs>
              <linearGradient id="lum-axis" x1="0" y1="0" x2="1" y2="0">
                {LUM_STOPS.map((c, i) => {
                  const offset = `${(i / (LUM_STOPS.length - 1)) * 100}%`
                  return <stop key={offset} offset={offset} stopColor={c} />
                })}
              </linearGradient>
            </defs>
            <rect
              x={0}
              y={0}
              width={VBW}
              height={VBH}
              fill="url(#lum-axis)"
              opacity={0.12}
              pointerEvents="none"
            />
            {lumaHist && ch === 'ls' && (
              <polygon
                points={histPoly(lumaHist)}
                fill="rgba(255,255,255,0.22)"
                stroke="none"
                pointerEvents="none"
              />
            )}
            {satHist && (ch === 'ss' || ch === 'sl') && (
              <polygon
                points={histPoly(satHist)}
                fill="rgba(255,255,255,0.22)"
                stroke="none"
                pointerEvents="none"
              />
            )}
          </>
        ) : (
          hist && (
            <g pointerEvents="none">
              {(['b', 'g', 'r'] as const).map((c) => (
                <polygon
                  key={c}
                  points={histPoly(hist[c])}
                  fill={c === 'r' ? '#ff5a5a' : c === 'g' ? '#5aff7d' : '#5a8cff'}
                  fillOpacity={0.45}
                  stroke="none"
                  style={{ mixBlendMode: 'screen' }}
                />
              ))}
            </g>
          )
        )}
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} stroke="rgba(255,255,255,0.07)" strokeWidth={0.5} pointerEvents="none">
            <line x1={g * VBW} y1={0} x2={g * VBW} y2={VBH} />
            <line x1={0} y1={g * VBH} x2={VBW} y2={g * VBH} />
          </g>
        ))}
        {/* Neutral reference: identity diagonal for tone, mid line for hue. */}
        {isHue ? (
          <line
            x1={0}
            y1={VBH / 2}
            x2={VBW}
            y2={VBH / 2}
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={0.5}
            pointerEvents="none"
          />
        ) : (
          <line
            x1={0}
            y1={VBH}
            x2={VBW}
            y2={0}
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={0.5}
            pointerEvents="none"
          />
        )}
        <polyline
          points={line}
          fill="none"
          stroke={color}
          strokeWidth={1.4}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
        {/* Symmetric ceiling/floor notches: drag the top one down (or the bottom
            one up) to compress the output range equally from both ends. */}
        {!isHue &&
          (
            [
              // top notch at the left, bottom notch at the right — diagonally
              // opposite, clear of the black/white endpoints in the other corners.
              ['top', ceilY, 6] as const,
              ['bottom', floorY, VBW - 6] as const,
            ] as const
          ).map(([side, y, cx]) => {
            // The arrow sits on the *outward* side of its line (above the top
            // notch, below the bottom one) so it pokes out of the box at the
            // extremes — the svg is overflow-visible, so it isn't clipped there.
            const dir = side === 'top' ? -1 : 1
            const tri = `${cx - 3},${y + dir * 6} ${cx + 3},${y + dir * 6} ${cx},${y}`
            return (
              <g key={side}>
                <line
                  x1={0}
                  y1={y}
                  x2={VBW}
                  y2={y}
                  stroke={color}
                  strokeOpacity={wht < 0.999 ? 0.4 : 0.15}
                  strokeWidth={0.5}
                  strokeDasharray="2 2"
                  pointerEvents="none"
                />
                {/* generous transparent hit area, biased to the protruding side */}
                <rect
                  x={cx - 10}
                  y={side === 'top' ? y - 12 : y - 3}
                  width={20}
                  height={15}
                  fill="transparent"
                  className="cursor-ns-resize"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return
                    e.stopPropagation()
                    dragCeil.current = side
                    svgRef.current?.setPointerCapture(e.pointerId)
                  }}
                />
                <polygon
                  points={tri}
                  fill={color}
                  stroke="#000"
                  strokeWidth={0.5}
                  pointerEvents="none"
                />
              </g>
            )
          })}
        {pts.map((p, i) => (
          <circle
            key={`${p.x}-${p.y}`}
            cx={p.x * VBW}
            cy={toScreenY(p.y)}
            r={activePt === i ? 3.8 : 2.6}
            fill={activePt === i ? '#fff' : color}
            stroke={activePt === i ? color : '#000'}
            strokeWidth={0.8}
            className="cursor-grab"
            onPointerDown={(e) => {
              if (e.button !== 0) return // let right-click fall through to remove
              e.stopPropagation()
              setActivePt(i)
              dragIndex.current = i
              svgRef.current?.setPointerCapture(e.pointerId)
            }}
            onPointerEnter={() => setActivePt(i)}
            onPointerLeave={() => setActivePt((prev) => (dragIndex.current !== null ? prev : null))}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              removePoint(i)
            }}
          />
        ))}
      </svg>

      {/* X/Y sliders for the active point — lets you nudge a point precisely
          without having to drag it manually across the curve area. */}
      {activePt !== null && activePt < pts.length && (
        <div className="flex items-center gap-3 px-1">
          {(
            [
              { label: 'X', key: 'x', min: 0, max: 1 },
              { label: 'Y', key: 'y', min: 0, max: 1 },
            ] as const
          ).map((axis) => {
            const ap = activePt
            const val = ap !== null ? (pts[ap]?.[axis.key] ?? 0) : 0
            return (
              <div key={axis.key} className="flex items-center gap-1.5">
                <span className="w-3 text-[10px] font-mono text-muted-foreground">
                  {axis.label}
                </span>
                <Slider
                  className="w-20"
                  value={[val]}
                  min={axis.min}
                  max={axis.max}
                  step={0.005}
                  onValueChange={(next) => {
                    const v = Array.isArray(next) ? next[0] : (next as number)
                    if (v === undefined || ap === null) return
                    const nextPts = pts.map((q) => Object.assign({}, q))
                    const target = nextPts[ap]
                    if (!target) return
                    if (axis.key === 'x') target.x = round(v)
                    else target.y = round(v)
                    const patch: NodeValues = {
                      [`crv${ch}_n`]: nextPts.length,
                    }
                    nextPts.forEach((q, k) => {
                      patch[`crv${ch}_x${k}`] = q.x
                      patch[`crv${ch}_y${k}`] = q.y
                    })
                    onChange(patch)
                  }}
                />
                <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                  {val.toFixed(3)}
                </span>
              </div>
            )
          })}
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">
        {ch === 'hh' || ch === 'hs' || ch === 'hl'
          ? 'x = source hue · click the image to drop points · right-click to remove'
          : isHue
            ? 'Click the image to drop points · right-click to remove'
            : 'Click + drag to add · right-click to remove · Spline for curves'}
      </p>
    </div>
  )
}
