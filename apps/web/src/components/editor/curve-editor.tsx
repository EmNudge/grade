import { useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { NodeValues } from '../../editor/store'
import { cn } from '../../lib/utils'

// Must match CURVE_MAX in @grade/nodes builtin.ts.
const MAX = 5
const CHANNELS = [
  { id: 'm', label: 'Y', color: '#e5e5e5' },
  { id: 'r', label: 'R', color: '#ff5a5a' },
  { id: 'g', label: 'G', color: '#5aff7d' },
  { id: 'b', label: 'B', color: '#6aa8ff' },
] as const

type Ch = (typeof CHANNELS)[number]['id']
interface Pt {
  x: number
  y: number
}

function num(v: unknown, fallback: number) {
  return typeof v === 'number' ? v : fallback
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
}: {
  values: NodeValues
  onChange: (patch: NodeValues) => void
}) {
  const [ch, setCh] = useState<Ch>('m')
  const svgRef = useRef<SVGSVGElement>(null)
  const dragIndex = useRef<number | null>(null)
  const color = CHANNELS.find((c) => c.id === ch)!.color
  const smooth = Boolean(values['crv_smooth'])

  const count = Math.round(num(values[`crv${ch}_n`], 2))
  const pts: Pt[] = Array.from({ length: count }, (_, i) => ({
    x: num(values[`crv${ch}_x${i}`], i === 0 ? 0 : 1),
    y: num(values[`crv${ch}_y${i}`], i === 0 ? 0 : 1),
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

  // Drag an existing point. Endpoints are x-locked at 0 and 1.
  const dragPoint = (clientX: number, clientY: number) => {
    const i = dragIndex.current
    if (i === null) return
    const p = fromEvent(clientX, clientY)
    const next = pts.map((q) => ({ ...q }))
    if (i === 0) next[0] = { x: 0, y: round(p.y) }
    else if (i === count - 1) next[count - 1] = { x: 1, y: round(p.y) }
    else {
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
    writePts([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ])

  // Sample the (possibly splined) curve for the polyline.
  const line = Array.from({ length: 65 }, (_, k) => {
    const x = k / 64
    return `${x * 100},${(1 - evalCurve(x, pts, smooth)) * 100}`
  }).join(' ')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
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
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="aspect-square w-full max-w-[240px] touch-none rounded-md border border-border bg-[#0d0d0d]"
        onPointerDown={(e) => {
          // Click on empty graph -> add a point and immediately start dragging it.
          if (e.target !== svgRef.current || count >= MAX) return
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
        {[25, 50, 75].map((g) => (
          <g key={g} stroke="rgba(255,255,255,0.07)" strokeWidth={0.5}>
            <line x1={g} y1={0} x2={g} y2={100} />
            <line x1={0} y1={g} x2={100} y2={g} />
          </g>
        ))}
        <line x1={0} y1={100} x2={100} y2={0} stroke="rgba(255,255,255,0.12)" strokeWidth={0.5} />
        <polyline
          points={line}
          fill="none"
          stroke={color}
          strokeWidth={1.4}
          vectorEffect="non-scaling-stroke"
        />
        {pts.map((p, i) => (
          <circle
            key={`${p.x}-${p.y}`}
            cx={p.x * 100}
            cy={(1 - p.y) * 100}
            r={2.6}
            fill={color}
            stroke="#000"
            strokeWidth={0.6}
            className="cursor-grab"
            onPointerDown={(e) => {
              e.stopPropagation()
              dragIndex.current = i
              svgRef.current?.setPointerCapture(e.pointerId)
            }}
            onDoubleClick={() => removePoint(i)}
          />
        ))}
      </svg>
      <p className="text-[10px] text-muted-foreground">
        Click + drag to add · double-click to remove · Spline for curves
      </p>
    </div>
  )
}
