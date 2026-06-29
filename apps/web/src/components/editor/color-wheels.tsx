import { useRef } from 'react'
import type { NodeDef } from '@grade/nodes'
import { RotateCcw } from 'lucide-react'
import type { NodeValues } from '../../editor/store'
import { Slider } from '../ui/slider'

const SIZE = 118
const R = SIZE / 2 - 9

// RGB primary directions on the wheel (y up): red top, green lower-left, blue
// lower-right. These sum to ~0, so dragging produces a pure chroma balance.
const GX = 0.8660254

interface Band {
  prefix: string
  label: string
  masterMin: number
  masterMax: number
  masterDefault: number
  rgbRange: number
}

function num(v: unknown, fallback: number) {
  return typeof v === 'number' ? v : fallback
}

/** DaVinci-style Lift/Gamma/Gain/Offset wheels for the color-correct node. */
export function ColorWheels({
  def,
  values,
  onChange,
}: {
  def: NodeDef
  values: NodeValues
  onChange: (patch: NodeValues) => void
}) {
  const bands: Band[] = ['lift', 'gamma', 'gain', 'offset'].flatMap((prefix) => {
    const m = def.params.find((p) => p.key === `${prefix}_m`)
    const r = def.params.find((p) => p.key === `${prefix}_r`)
    if (!m || !r) return []
    return [
      {
        prefix,
        label: prefix.charAt(0).toUpperCase() + prefix.slice(1),
        masterMin: m.min ?? 0,
        masterMax: m.max ?? 1,
        masterDefault: Number(m.default),
        rgbRange: r.max ?? 0.5,
      },
    ]
  })

  return (
    <div className="grid grid-cols-2 gap-3 p-3 [@media(min-width:520px)]:grid-cols-4">
      {bands.map((b) => (
        <Wheel key={b.prefix} band={b} values={values} onChange={onChange} />
      ))}
    </div>
  )
}

function Wheel({
  band,
  values,
  onChange,
}: {
  band: Band
  values: NodeValues
  onChange: (patch: NodeValues) => void
}) {
  const { prefix, label, masterMin, masterMax, masterDefault, rgbRange } = band
  const padRef = useRef<HTMLDivElement>(null)
  // Relative drag: remember where the grab started and the values at that point.
  const drag = useRef<{ x: number; y: number; r: number; g: number; b: number } | null>(null)

  const r = num(values[`${prefix}_r`], 0)
  const g = num(values[`${prefix}_g`], 0)
  const bch = num(values[`${prefix}_b`], 0)
  const master = num(values[`${prefix}_m`], masterDefault)

  // Recover handle position from the current RGB trims.
  const py = r / rgbRange
  const px = (bch - g) / (2 * GX * rgbRange)
  const hx = SIZE / 2 + px * R
  const hy = SIZE / 2 - py * R

  // Move relative to grab point, damped — DaVinci-style fine control. The full
  // pad width spans only a fraction of the range, so subtle edits are easy and
  // it takes deliberate movement to push the center far.
  const apply = (clientX: number, clientY: number) => {
    const start = drag.current
    if (!start) return
    const SENSITIVITY = 0.35
    const dnx = ((clientX - start.x) / R) * SENSITIVITY
    const dny = (-(clientY - start.y) / R) * SENSITIVITY
    const clamp = (v: number) => Math.max(-rgbRange, Math.min(rgbRange, v))
    const round = (v: number) => Math.round(v * 1000) / 1000
    onChange({
      [`${prefix}_r`]: round(clamp(start.r + dny * rgbRange)),
      [`${prefix}_g`]: round(clamp(start.g + (-GX * dnx - 0.5 * dny) * rgbRange)),
      [`${prefix}_b`]: round(clamp(start.b + (GX * dnx - 0.5 * dny) * rgbRange)),
    })
  }

  const reset = () =>
    onChange({
      [`${prefix}_m`]: masterDefault,
      [`${prefix}_r`]: 0,
      [`${prefix}_g`]: 0,
      [`${prefix}_b`]: 0,
    })

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex w-full items-center justify-between px-1">
        <span className="text-[11px] font-medium">{label}</span>
        <button
          type="button"
          onClick={reset}
          className="text-muted-foreground transition-colors hover:text-foreground"
          title={`Reset ${label}`}
        >
          <RotateCcw className="size-3" />
        </button>
      </div>

      <div
        ref={padRef}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, r, g, b: bch }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (drag.current) apply(e.clientX, e.clientY)
        }}
        onPointerUp={(e) => {
          drag.current = null
          e.currentTarget.releasePointerCapture(e.pointerId)
        }}
        onDoubleClick={reset}
        className="relative cursor-crosshair touch-none rounded-full border border-border"
        style={{
          width: SIZE,
          height: SIZE,
          background:
            'radial-gradient(circle at center, rgba(255,255,255,0.06), rgba(0,0,0,0.5) 72%),' +
            'conic-gradient(from 90deg, #ff5a5a, #ffd25a, #5aff7d, #5affff, #5a7dff, #d25aff, #ff5a5a)',
        }}
      >
        <div className="absolute inset-[30%] rounded-full bg-background/70" />
        <div
          className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-black/60 shadow"
          style={{ left: hx, top: hy }}
        />
      </div>

      <Slider
        className="w-full"
        value={[master]}
        min={masterMin}
        max={masterMax}
        step={0.005}
        onValueChange={(next) =>
          onChange({ [`${prefix}_m`]: Array.isArray(next) ? next[0] : (next as number) })
        }
      />
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
        {master.toFixed(3)}
      </span>
    </div>
  )
}
