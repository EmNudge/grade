import { CHROMA_HUES } from '@grade/nodes'
import { RotateCcw } from 'lucide-react'
import { useRef, useState } from 'react'
import type { NodeValues } from '../../editor/store'

const SIZE = 240
const C = SIZE / 2
const R_WHEEL = C - 16 // outer radius the handles can reach
const R_SAT1 = R_WHEEL * 0.5 // radius that represents saturation = 1 (neutral)
const HUE_RANGE = 0.1 // cw_h ±1 -> ±0.1 turn (±36°), matching the shader's blend
const N = CHROMA_HUES.length

function num(v: unknown, fallback: number) {
  return typeof v === 'number' ? v : fallback
}

// hue fraction (0 = red, increasing clockwise) -> unit screen direction (y down).
function dir(f: number) {
  const a = f * Math.PI * 2
  return { x: Math.sin(a), y: -Math.cos(a) }
}

const round2 = (v: number) => Math.round(v * 100) / 100

/**
 * Chroma Warp — a DaVinci Color-Warper-style 2D control. Six hue control points
 * sit around the chroma wheel; drag one **around** the wheel to shift that hue,
 * or **in/out** to change its saturation. Maps directly onto the shader's
 * cw_h_* (hue shift) and cw_s_* (saturation) params — no shader changes.
 */
export function ChromaWarp({
  values,
  onChange,
}: {
  values: NodeValues
  onChange: (patch: NodeValues) => void
}) {
  const padRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<number | null>(null)
  const [active, setActive] = useState<number | null>(null)

  const points = CHROMA_HUES.map((h, i) => {
    const f = i / N
    const hueShift = num(values[`cw_h_${h.key}`], 0)
    const sat = num(values[`cw_s_${h.key}`], 1)
    const radius = Math.min(R_WHEEL, Math.max(0, R_SAT1 * sat))
    const wd = dir(f + hueShift * HUE_RANGE)
    const bd = dir(f)
    return {
      ...h,
      i,
      hueShift,
      sat,
      x: C + wd.x * radius,
      y: C + wd.y * radius,
      bx: C + bd.x * R_SAT1,
      by: C + bd.y * R_SAT1,
    }
  })

  const apply = (clientX: number, clientY: number) => {
    const i = dragRef.current
    const pad = padRef.current
    const h = i == null ? undefined : CHROMA_HUES[i]
    if (i == null || !pad || !h) return
    const rect = pad.getBoundingClientRect()
    const dx = clientX - rect.left - C
    const dy = clientY - rect.top - C
    // radial distance -> saturation, angle offset from the hue's home -> hue shift.
    const radius = Math.min(R_WHEEL, Math.hypot(dx, dy))
    const sat = round2(Math.max(0, Math.min(2, radius / R_SAT1)))
    const frac = Math.atan2(dx, -dy) / (Math.PI * 2)
    let d = frac - i / N
    d -= Math.round(d) // wrap delta into [-0.5, 0.5]
    const hueShift = round2(Math.max(-1, Math.min(1, d / HUE_RANGE)))
    onChange({ [`cw_h_${h.key}`]: hueShift, [`cw_s_${h.key}`]: sat })
  }

  const resetPoint = (key: string) => onChange({ [`cw_h_${key}`]: 0, [`cw_s_${key}`]: 1 })

  const resetAll = () => {
    const patch: NodeValues = {}
    for (const h of CHROMA_HUES) {
      patch[`cw_h_${h.key}`] = 0
      patch[`cw_s_${h.key}`] = 1
    }
    onChange(patch)
  }

  const warpPath = `M ${points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')} Z`
  const neutralPath = `M ${points.map((p) => `${p.bx.toFixed(1)} ${p.by.toFixed(1)}`).join(' L ')} Z`
  const cur = active != null ? points[active] : null

  return (
    <div className="flex flex-col items-center gap-3 p-1">
      <div className="flex w-full items-center justify-between">
        <span className="text-[11px] text-muted-foreground">Chroma Warp</span>
        <button
          type="button"
          onClick={resetAll}
          className="text-muted-foreground transition-colors hover:text-foreground"
          title="Reset chroma warp"
        >
          <RotateCcw className="size-3.5" />
        </button>
      </div>

      <div
        ref={padRef}
        onPointerMove={(e) => {
          if (dragRef.current != null) apply(e.clientX, e.clientY)
        }}
        onPointerUp={(e) => {
          dragRef.current = null
          setActive(null)
          e.currentTarget.releasePointerCapture(e.pointerId)
        }}
        className="relative touch-none select-none rounded-full"
        style={{ width: SIZE, height: SIZE }}
      >
        {/* Chroma wheel: hue around, desaturating toward the centre. */}
        <div
          className="absolute inset-0 rounded-full border border-border"
          style={{
            background:
              'radial-gradient(circle at center, rgba(20,20,24,0.92), rgba(20,20,24,0) 62%),' +
              'conic-gradient(from 0deg, #ff5a5a, #ffd25a, #5aff7d, #5affff, #5a7dff, #d25aff, #ff5a5a)',
          }}
        />

        <svg className="absolute inset-0" width={SIZE} height={SIZE} aria-hidden>
          {/* polar mesh grid */}
          {[0.33, 0.66, 1].map((t) => (
            <circle
              key={t}
              cx={C}
              cy={C}
              r={R_WHEEL * t}
              fill="none"
              stroke="rgba(255,255,255,0.12)"
              strokeWidth={1}
            />
          ))}
          {Array.from({ length: 12 }, (_, k) => {
            const d = dir(k / 12)
            return (
              <line
                key={k}
                x1={C}
                y1={C}
                x2={C + d.x * R_WHEEL}
                y2={C + d.y * R_WHEEL}
                stroke="rgba(255,255,255,0.1)"
                strokeWidth={1}
              />
            )
          })}

          {/* neutral reference shape vs. the warped shape */}
          <path
            d={neutralPath}
            fill="none"
            stroke="rgba(255,255,255,0.25)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <path
            d={warpPath}
            fill="rgba(255,255,255,0.06)"
            stroke="rgba(255,255,255,0.5)"
            strokeWidth={1.5}
          />

          {/* per-point warp vectors + draggable handles */}
          {points.map((p) => (
            <g key={p.key}>
              <line
                x1={p.bx}
                y1={p.by}
                x2={p.x}
                y2={p.y}
                stroke="rgba(255,255,255,0.35)"
                strokeWidth={1}
              />
              <circle cx={p.bx} cy={p.by} r={2.5} fill="rgba(255,255,255,0.4)" />
              <circle
                cx={p.x}
                cy={p.y}
                r={active === p.i ? 8 : 6}
                fill={p.color}
                stroke="#fff"
                strokeWidth={2}
                className="cursor-grab active:cursor-grabbing"
                style={{ pointerEvents: 'all' }}
                onPointerDown={(e) => {
                  dragRef.current = p.i
                  setActive(p.i)
                  padRef.current?.setPointerCapture(e.pointerId)
                }}
                onDoubleClick={() => resetPoint(p.key)}
              >
                <title>{p.label}</title>
              </circle>
            </g>
          ))}
        </svg>
      </div>

      {/* readout for the active (or last-touched) handle */}
      <div className="flex h-4 items-center gap-2 font-mono text-[10px] tabular-nums text-muted-foreground">
        {cur ? (
          <>
            <span className="size-2.5 rounded-full" style={{ background: cur.color }} />
            <span className="text-foreground">{cur.label}</span>
            <span>hue {(cur.hueShift * 36).toFixed(0)}°</span>
            <span>sat {cur.sat.toFixed(2)}×</span>
          </>
        ) : (
          <span>Drag a point — around to shift hue, in/out for saturation</span>
        )}
      </div>
    </div>
  )
}
