import { useEffect, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { type NodeValues, useEditor } from '../../editor/store'
import { cn } from '../../lib/utils'

// Must match CURVE_MAX in @grade/nodes builtin.ts.
const MAX = 5

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

const ALL_CHANNELS = [...CHANNELS, ...HUE_CURVES]
type Ch = (typeof ALL_CHANNELS)[number]['id']
const isHueCh = (ch: Ch): boolean => ch === 'hh' || ch === 'hs' || ch === 'hl'

// Rainbow stops for the hue-curve x-axis backdrop (red→…→red, one turn).
const HUE_STOPS = ['#ff5a5a', '#ffd25a', '#5aff7d', '#5affff', '#5a7dff', '#d25aff', '#ff5a5a']
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

/** 256-bin distribution of a frame's pixels for one channel (R/G/B or Y luma). */
function histogramBins(frame: Frame, ch: Ch): number[] {
  const { data } = frame
  const bgra = frame.format === 'BGRA'
  const bins = new Float32Array(256)
  for (let i = 0; i < data.length; i += 4) {
    const r = data[bgra ? i + 2 : i] ?? 0
    const g = data[i + 1] ?? 0
    const b = data[bgra ? i : i + 2] ?? 0
    const v =
      ch === 'r'
        ? r
        : ch === 'g'
          ? g
          : ch === 'b'
            ? b
            : Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
    const bin = v < 0 ? 0 : v > 255 ? 255 : v
    bins[bin] = (bins[bin] ?? 0) + 1
  }
  // Normalise to the tallest interior bin so pure-black/white spikes don't flatten it.
  let max = 1
  for (let i = 1; i < 255; i++) max = Math.max(max, bins[i] ?? 0)
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
        const p0 = at(i - 1).y
        const p1 = a.y
        const p2 = b.y
        const p3 = at(i + 2).y
        const t2 = t * t
        const t3 = t2 * t
        return (
          0.5 *
          (2 * p1 +
            (-p0 + p2) * t +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
            (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
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
  const color = ALL_CHANNELS.find((c) => c.id === ch)!.color
  const isHue = isHueCh(ch)
  const smooth = Boolean(values['crv_smooth'])

  // Upstream signal distribution, drawn behind the grid. Sampled off the engine
  // at the node's input, so it reflects everything before this curve.
  const engine = useEditor((s) => s.engine)
  const [hist, setHist] = useState<number[] | null>(null)
  const chRef = useRef(ch)
  chRef.current = ch

  useEffect(() => {
    if (!engine || !histogramSource) {
      setHist(null)
      return undefined
    }
    engine.setHistogramSource(histogramSource)
    const live = { current: true }
    let busy = false
    let timer = 0
    const tick = async () => {
      if (!live.current) return
      if (!busy) {
        busy = true
        try {
          const frame = await engine.sampleNodeInput(HIST_W, HIST_H)
          if (live.current) setHist(frame ? histogramBins(frame, chRef.current) : null)
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
  }, [engine, histogramSource])

  // Filled area under the (normalised) bins, in the viewBox; bottom-anchored.
  const histPoints =
    hist &&
    `0,${VBH} ${hist
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
  }

  const reset = () =>
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

  // Sample the (possibly splined) curve for the polyline.
  const line = Array.from({ length: 65 }, (_, k) => {
    const x = k / 64
    return `${(x * VBW).toFixed(2)},${((1 - evalCurve(x, pts, smooth)) * VBH).toFixed(2)}`
  }).join(' ')

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
        </div>
        <div className="flex items-center gap-1">
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
        className="aspect-[2/1] w-full max-w-[400px] touch-none rounded-md border border-border bg-[#0d0d0d]"
        onPointerDown={(e) => {
          // Grabbing a handle stops propagation (see the circles below), so any
          // pointerdown that reaches the svg is on empty space: add a point and
          // immediately start dragging it. (Don't gate on e.target — clicks that
          // land on the grid/curve/histogram should add too, not be rejected.)
          if (e.button !== 0 || count >= MAX) return
          const p = fromEvent(e.clientX, e.clientY)
          const nx = round(p.x)
          dragIndex.current = pts.filter((q) => q.x < nx).length
          writePts([...pts, { x: nx, y: round(p.y) }])
          svgRef.current?.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (dragIndex.current !== null) dragPoint(e.clientX, e.clientY)
        }}
        onPointerUp={(e) => {
          dragIndex.current = null
          svgRef.current?.releasePointerCapture(e.pointerId)
        }}
      >
        {/* Decorative layers ignore pointer events so the draggable handles
            below are the only interactive children; clicks anywhere else fall
            through to the svg's onPointerDown and add a point. */}
        {/* Hue curves get a rainbow x-axis strip; tone curves the signal histogram. */}
        {isHue ? (
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
          </>
        ) : (
          histPoints && (
            <polygon
              points={histPoints}
              fill={color}
              fillOpacity={0.16}
              stroke="none"
              pointerEvents="none"
            />
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
        {pts.map((p, i) => (
          <circle
            key={`${p.x}-${p.y}`}
            cx={p.x * VBW}
            cy={(1 - p.y) * VBH}
            r={2.6}
            fill={color}
            stroke="#000"
            strokeWidth={0.6}
            className="cursor-grab"
            onPointerDown={(e) => {
              if (e.button !== 0) return // let right-click fall through to remove
              e.stopPropagation()
              dragIndex.current = i
              svgRef.current?.setPointerCapture(e.pointerId)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              removePoint(i)
            }}
          />
        ))}
      </svg>
      <p className="text-[10px] text-muted-foreground">
        {isHue
          ? 'x = source hue · drag to shift hue / sat / luma · right-click to remove'
          : 'Click + drag to add · right-click to remove · Spline for curves'}
      </p>
    </div>
  )
}
