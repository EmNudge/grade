import { CHROMA_HUES } from '@grade/nodes'
import { RotateCcw } from 'lucide-react'
import { useRef, useState } from 'react'
import type { NodeValues } from '../../editor/store'

const W = 240
const H = 184
const PAD = 16 // top/bottom inset so handles aren't clipped at the extremes
const USABLE = H - PAD * 2
const HALF = USABLE / 2 // luminance = 1 sits on this mid-line
const HUE_PX = 0.1 * W // horizontal travel for a full ±1 hue bend (±36°)
const N = CHROMA_HUES.length

function num(v: unknown, fallback: number) {
  return typeof v === 'number' ? v : fallback
}

const round2 = (v: number) => Math.round(v * 100) / 100
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// Home x for hue sector i — centred in its band so the 6 points spread evenly.
const homeX = (i: number) => ((i + 0.5) / N) * W
// luminance gain (0..2) <-> vertical screen position (gain 1 on the mid-line).
const lumToY = (l: number) => PAD + USABLE * (1 - l / 2)
const yToLum = (y: number) => clamp(2 * (1 - (y - PAD) / USABLE), 0, 2)

/**
 * Color Warp — the hue-vs-lightness half of DaVinci's Color Warper. Six hue
 * control points sit across the spectrum; drag one **up/down** to brighten or
 * darken that hue, or **left/right** to bend its hue toward a neighbour. Maps
 * onto the corrector's lw_h_* (hue bend) and lw_l_* (luma) params — no shader
 * changes. The chroma wheel handles hue/saturation; this handles hue/luminance.
 */
export function ColorWarp({
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
    const hueShift = num(values[`lw_h_${h.key}`], 0)
    const lum = num(values[`lw_l_${h.key}`], 1)
    const hx = homeX(i)
    return {
      ...h,
      i,
      hueShift,
      lum,
      hx,
      x: hx + hueShift * HUE_PX,
      y: lumToY(lum),
    }
  })

  const apply = (clientX: number, clientY: number) => {
    const i = dragRef.current
    const pad = padRef.current
    const h = i == null ? undefined : CHROMA_HUES[i]
    if (i == null || !pad || !h) return
    const rect = pad.getBoundingClientRect()
    const dx = clientX - rect.left - homeX(i)
    const hueShift = round2(clamp(dx / HUE_PX, -1, 1))
    const lum = round2(yToLum(clientY - rect.top))
    onChange({ [`lw_h_${h.key}`]: hueShift, [`lw_l_${h.key}`]: lum })
  }

  const resetPoint = (key: string) => onChange({ [`lw_h_${key}`]: 0, [`lw_l_${key}`]: 1 })

  const resetAll = () => {
    const patch: NodeValues = {}
    for (const h of CHROMA_HUES) {
      patch[`lw_h_${h.key}`] = 0
      patch[`lw_l_${h.key}`] = 1
    }
    onChange(patch)
  }

  // Left-to-right hue gradient with each sector colour centred under its point.
  const hueStops = [
    `${CHROMA_HUES[0]!.color} 0%`,
    ...CHROMA_HUES.map((h, i) => `${h.color} ${(((i + 0.5) / N) * 100).toFixed(1)}%`),
    `${CHROMA_HUES.at(-1)!.color} 100%`,
  ].join(', ')

  const warpPath = `M ${points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')}`
  const cur = active != null ? points[active] : null

  return (
    <div className="flex flex-col items-center gap-3 p-1">
      <div className="flex w-full items-center justify-between">
        <span className="text-[11px] text-muted-foreground">Color Warp</span>
        <button
          type="button"
          onClick={resetAll}
          className="text-muted-foreground transition-colors hover:text-foreground"
          title="Reset color warp"
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
        className="relative touch-none select-none overflow-hidden rounded-md border border-border"
        style={{ width: W, height: H }}
      >
        {/* Hue across, brighter toward the top — the warp's working space. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(to top, rgba(0,0,0,0.6), rgba(0,0,0,0) 45%, rgba(255,255,255,0.14)),' +
              `linear-gradient(to right, ${hueStops})`,
          }}
        />

        <svg className="absolute inset-0" width={W} height={H} aria-hidden>
          {/* luminance = 1 reference line + per-hue column guides */}
          <line
            x1={0}
            y1={PAD + HALF}
            x2={W}
            y2={PAD + HALF}
            stroke="rgba(255,255,255,0.3)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          {points.map((p) => (
            <line
              key={`g${p.key}`}
              x1={p.hx}
              y1={PAD}
              x2={p.hx}
              y2={H - PAD}
              stroke="rgba(255,255,255,0.1)"
              strokeWidth={1}
            />
          ))}

          {/* warped profile through the handles */}
          <path d={warpPath} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />

          {points.map((p) => (
            <g key={p.key}>
              {/* vector from the neutral home (mid-line) to the handle */}
              <line
                x1={p.hx}
                y1={PAD + HALF}
                x2={p.x}
                y2={p.y}
                stroke="rgba(255,255,255,0.35)"
                strokeWidth={1}
              />
              <circle cx={p.hx} cy={PAD + HALF} r={2.5} fill="rgba(255,255,255,0.4)" />
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
            <span>luma {cur.lum.toFixed(2)}×</span>
            <span>hue {(cur.hueShift * 36).toFixed(0)}°</span>
          </>
        ) : (
          <span>Drag a point — up/down for luminance, sideways to bend hue</span>
        )}
      </div>
    </div>
  )
}
