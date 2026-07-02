import { InfoDecorator } from './info-decorator'
import type { Engine } from '@grade/engine'
import { CHROMA_PT_MAX } from '@grade/nodes'
import { Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditor } from '../../editor/store'
import type { NodeValues } from '../../editor/store'

const SIZE = 260
const C = SIZE / 2
const R = C - 18 // radius of the chroma disk (saturation = 1 at the edge)
const TAU = Math.PI * 2

// Per-stroke fields and their neutral defaults, matching the shader params.
const FIELDS = ['sx', 'sy', 'tx', 'ty', 'r', 'e'] as const
type Field = (typeof FIELDS)[number]
const DEFAULTS: Record<Field, number> = { sx: 0, sy: 0, tx: 0, ty: 0, r: 0.25, e: 0 }

function num(v: unknown, fallback: number) {
  return typeof v === 'number' ? v : fallback
}
const round3 = (v: number) => Math.round(v * 1000) / 1000
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// chroma coords (cx,cy ∈ unit disk, y up) <-> screen position.
const toScreen = (cx: number, cy: number) => ({ x: C + cx * R, y: C - cy * R })
function toChroma(sx: number, sy: number) {
  let cx = (sx - C) / R
  let cy = -(sy - C) / R
  const len = Math.hypot(cx, cy)
  if (len > 1) {
    cx /= len
    cy /= len
  }
  return { cx, cy }
}

// hue (0..1) + saturation (0..1) from linear-ish RGB, matching the shader's
// grade_rgb2hsv so the scatter lands where the disk says a colour should be.
function rgb2hs(r: number, g: number, b: number) {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const d = mx - mn
  let h = 0
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
    if (h < 0) h += 1
  }
  return { h, s: mx <= 0 ? 0 : d / mx }
}

// css colour for a chroma point (matches the disk's hue/sat layout).
function chromaCss(cx: number, cy: number) {
  const hue = (((Math.atan2(cy, cx) / TAU) % 1) + 1) % 1
  const sat = clamp(Math.hypot(cx, cy), 0, 1)
  return `hsl(${(hue * 360).toFixed(0)} 90% ${(70 - sat * 35).toFixed(0)}%)`
}

// Scatter a graded frame's chroma onto the disk as translucent white traces
// (DaVinci shows the image data this way over the gamut). `acc`/`img` are reused
// across frames to avoid per-frame allocation.
function drawScatter(
  ctx: CanvasRenderingContext2D,
  acc: Float32Array,
  img: ImageData,
  frame: { data: Uint8ClampedArray; format: 'RGBA' | 'BGRA'; width: number; height: number } | null,
) {
  const px = img.data
  px.fill(0)
  if (!frame) {
    ctx.putImageData(img, 0, 0)
    return
  }
  acc.fill(0)
  const { data, format, width, height } = frame
  const bgra = format === 'BGRA'
  let max = 1
  for (let i = 0; i < width * height; i++) {
    const si = i * 4
    const r = (data[bgra ? si + 2 : si] ?? 0) / 255
    const g = (data[si + 1] ?? 0) / 255
    const b = (data[bgra ? si : si + 2] ?? 0) / 255
    const { h, s } = rgb2hs(r, g, b)
    if (s <= 0.004) continue
    const a = h * TAU
    const ox = (C + s * Math.cos(a) * R) | 0
    const oy = (C - s * Math.sin(a) * R) | 0
    if (ox < 0 || ox >= SIZE || oy < 0 || oy >= SIZE) continue
    const idx = oy * SIZE + ox
    const v = (acc[idx] ?? 0) + 1
    acc[idx] = v
    if (v > max) max = v
  }
  const norm = 1 / Math.log1p(max)
  for (let i = 0; i < acc.length; i++) {
    const v = acc[i]
    if (!v) continue
    const a = Math.min(1, Math.log1p(v) * norm * 2.4)
    const o = i * 4
    px[o] = 245
    px[o + 1] = 245
    px[o + 2] = 245
    px[o + 3] = Math.round(a * 200)
  }
  ctx.putImageData(img, 0, 0)
}

// hue wheel aligned to the chroma math: a point at chroma angle `a` (ccw from +x)
// sits at css conic angle φ = 90° − a, so hue(φ) = (90 − φ)/360.
const CONIC = (() => {
  const M = 24
  const stops: string[] = []
  for (let k = 0; k <= M; k++) {
    const phi = (k / M) * 360
    const hue = ((((90 - phi) / 360) % 1) + 1) % 1
    stops.push(`hsl(${(hue * 360).toFixed(0)} 100% 55%) ${phi.toFixed(1)}deg`)
  }
  return `conic-gradient(${stops.join(', ')})`
})()

interface Stroke {
  i: number
  src: { cx: number; cy: number }
  tgt: { cx: number; cy: number }
  range: number
  exposure: number
}

type DragMode = 'src' | 'tgt'

/**
 * Chroma Warp — DaVinci Color-Warper "Chroma Warp". Drop strokes on a
 * chromaticity disk: click-drag from a source colour to a target to pull nearby
 * colours that way. Each stroke has a Chroma Range (falloff) and Exposure; a
 * global Tonal Range gates the warp by luminance. Drives the shader's
 * cw_n / cw_{sx,sy,tx,ty,r,e}{i} / cw_t{lo,hi,pv} params.
 */
export function ChromaWarp({
  values,
  onChange,
}: {
  values: NodeValues
  onChange: (patch: NodeValues) => void
}) {
  const padRef = useRef<HTMLDivElement>(null)
  const scopeRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<{ i: number; mode: DragMode } | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const engine = useEditor((s) => s.engine)

  // Live vectorscope: sample the graded frame off the GPU and scatter each
  // pixel's chroma onto the disk in the *same* hue/sat space as the warp
  // controls. Because the sample is post-grade, the cloud moves as you warp —
  // so the strokes' effect on the footage is visible right here.
  const engineRef = useRef<Engine | null>(engine)
  engineRef.current = engine
  useEffect(() => {
    const canvas = scopeRef.current
    const ctx = canvas?.getContext('2d', { willReadFrequently: true })
    if (!ctx) return undefined
    const live = { on: true }
    const acc = new Float32Array(SIZE * SIZE)
    const img = ctx.createImageData(SIZE, SIZE)
    const pump = async () => {
      while (live.on) {
        const eng = engineRef.current
        let frame: Awaited<ReturnType<Engine['sampleScopes']>> = null
        if (eng) {
          try {
            // Match the Scopes panel's sample size so the shared GPU readback
            // coalesces instead of reallocating the scope target each tick.
            frame = await eng.sampleScopes(320, 180)
          } catch {
            frame = null
          }
        }
        if (live.on) drawScatter(ctx, acc, img, frame)
        await new Promise((r) => setTimeout(r, 66))
      }
    }
    void pump()
    return () => {
      live.on = false
    }
  }, [])

  const count = Math.round(num(values['cw_n'], 0))
  const tlo = num(values['cw_tlo'], 1)
  const thi = num(values['cw_thi'], 1)
  const tpv = num(values['cw_tpv'], 0.5)

  const strokes = useMemo<Stroke[]>(() => {
    const out: Stroke[] = []
    for (let i = 0; i < count; i++) {
      out.push({
        i,
        src: { cx: num(values[`cw_sx${i}`], 0), cy: num(values[`cw_sy${i}`], 0) },
        tgt: { cx: num(values[`cw_tx${i}`], 0), cy: num(values[`cw_ty${i}`], 0) },
        range: num(values[`cw_r${i}`], DEFAULTS.r),
        exposure: num(values[`cw_e${i}`], 0),
      })
    }
    return out
  }, [values, count])

  const set = (i: number, field: Field, v: number) => onChange({ [`cw_${field}${i}`]: round3(v) })

  const addStroke = (cx: number, cy: number) => {
    if (count >= CHROMA_PT_MAX) return null
    const i = count
    onChange({
      [`cw_sx${i}`]: round3(cx),
      [`cw_sy${i}`]: round3(cy),
      [`cw_tx${i}`]: round3(cx),
      [`cw_ty${i}`]: round3(cy),
      [`cw_r${i}`]: DEFAULTS.r,
      [`cw_e${i}`]: 0,
      cw_n: i + 1,
    })
    return i
  }

  const removeStroke = (idx: number) => {
    const patch: NodeValues = {}
    for (let j = idx; j < count - 1; j++) {
      for (const f of FIELDS) patch[`cw_${f}${j}`] = num(values[`cw_${f}${j + 1}`], DEFAULTS[f])
    }
    for (const f of FIELDS) patch[`cw_${f}${count - 1}`] = DEFAULTS[f]
    patch['cw_n'] = Math.max(0, count - 1)
    onChange(patch)
    setSelected(null)
  }

  const resetAll = () => {
    const patch: NodeValues = { cw_n: 0, cw_tlo: 1, cw_thi: 1, cw_tpv: 0.5 }
    for (let i = 0; i < CHROMA_PT_MAX; i++) {
      for (const f of FIELDS) patch[`cw_${f}${i}`] = DEFAULTS[f]
    }
    onChange(patch)
    setSelected(null)
  }

  const apply = (clientX: number, clientY: number) => {
    const drag = dragRef.current
    const pad = padRef.current
    if (!drag || !pad) return
    const rect = pad.getBoundingClientRect()
    const { cx, cy } = toChroma(clientX - rect.left, clientY - rect.top)
    if (drag.mode === 'src') {
      set(drag.i, 'sx', cx)
      set(drag.i, 'sy', cy)
    } else {
      set(drag.i, 'tx', cx)
      set(drag.i, 'ty', cy)
    }
  }

  const startDrag = (e: React.PointerEvent, i: number, mode: DragMode) => {
    e.stopPropagation()
    dragRef.current = { i, mode }
    setSelected(i)
    padRef.current?.setPointerCapture(e.pointerId)
  }

  // pointer-down on empty disk: create a stroke at the source and drag its target.
  const onPadDown = (e: React.PointerEvent) => {
    const pad = padRef.current
    if (!pad) return
    const rect = pad.getBoundingClientRect()
    const { cx, cy } = toChroma(e.clientX - rect.left, e.clientY - rect.top)
    const i = addStroke(cx, cy)
    if (i == null) return
    dragRef.current = { i, mode: 'tgt' }
    setSelected(i)
    pad.setPointerCapture(e.pointerId)
  }

  const cur = selected != null && selected < count ? strokes[selected] : null
  // primaries triangle (R/G/B at full saturation) — a DaVinci-style gamut hint.
  const prim = [0, 1 / 3, 2 / 3].map((h) => toScreen(Math.cos(h * TAU), Math.sin(h * TAU)))
  const primPath = `M ${prim.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')} Z`

  return (
    <div className="flex flex-col items-center gap-3 p-1">
      <div className="flex w-full items-center justify-between">
        <InfoDecorator descKey="chroma">
          <span className="text-[11px] text-muted-foreground">Chroma Warp</span>
        </InfoDecorator>
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
        onPointerDown={onPadDown}
        onPointerMove={(e) => {
          if (dragRef.current) apply(e.clientX, e.clientY)
        }}
        onPointerUp={(e) => {
          dragRef.current = null
          e.currentTarget.releasePointerCapture(e.pointerId)
        }}
        className="relative touch-none select-none rounded-full"
        style={{ width: SIZE, height: SIZE }}
      >
        {/* chromaticity disk: hue around, desaturating toward the centre. */}
        <div
          className="absolute inset-0 rounded-full border border-border"
          style={{
            background: `radial-gradient(circle at center, rgba(18,18,22,0.95), rgba(18,18,22,0) 60%), ${CONIC}`,
          }}
        />

        {/* live chroma scatter of the graded frame (the embedded vectorscope) */}
        <canvas
          ref={scopeRef}
          width={SIZE}
          height={SIZE}
          className="pointer-events-none absolute inset-0 rounded-full"
        />

        <svg className="absolute inset-0" width={SIZE} height={SIZE} aria-hidden>
          {/* polar mesh grid */}
          {[0.33, 0.66, 1].map((t) => (
            <circle
              key={t}
              cx={C}
              cy={C}
              r={R * t}
              fill="none"
              stroke="rgba(255,255,255,0.1)"
              strokeWidth={1}
            />
          ))}
          {Array.from({ length: 12 }, (_, k) => {
            const d = toScreen(Math.cos((k / 12) * TAU), Math.sin((k / 12) * TAU))
            return (
              <line
                key={k}
                x1={C}
                y1={C}
                x2={d.x}
                y2={d.y}
                stroke="rgba(255,255,255,0.08)"
                strokeWidth={1}
              />
            )
          })}
          {/* gamut hint triangle */}
          <path
            d={primPath}
            fill="none"
            stroke="rgba(255,255,255,0.18)"
            strokeWidth={1}
            strokeDasharray="2 3"
          />

          {/* strokes: range ring + source/target handles + warp vector */}
          {strokes.map((s) => {
            const sp = toScreen(s.src.cx, s.src.cy)
            const tp = toScreen(s.tgt.cx, s.tgt.cy)
            const active = selected === s.i
            return (
              <g key={s.i}>
                <circle
                  cx={sp.x}
                  cy={sp.y}
                  r={s.range * R}
                  fill="none"
                  stroke={active ? 'rgba(255,140,90,0.7)' : 'rgba(255,140,90,0.3)'}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                <line
                  x1={sp.x}
                  y1={sp.y}
                  x2={tp.x}
                  y2={tp.y}
                  stroke="rgba(255,120,80,0.85)"
                  strokeWidth={1.5}
                  strokeDasharray="3 2"
                  markerEnd="url(#cw-arrow)"
                />
                {/* source handle */}
                <circle
                  cx={sp.x}
                  cy={sp.y}
                  r={5}
                  fill="rgba(20,20,24,0.6)"
                  stroke="#fff"
                  strokeWidth={1.5}
                  className="cursor-grab active:cursor-grabbing"
                  style={{ pointerEvents: 'all' }}
                  onPointerDown={(e) => startDrag(e, s.i, 'src')}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    removeStroke(s.i)
                  }}
                />
                {/* target handle */}
                <circle
                  cx={tp.x}
                  cy={tp.y}
                  r={active ? 8 : 6}
                  fill={chromaCss(s.tgt.cx, s.tgt.cy)}
                  stroke="#fff"
                  strokeWidth={2}
                  className="cursor-grab active:cursor-grabbing"
                  style={{ pointerEvents: 'all' }}
                  onPointerDown={(e) => startDrag(e, s.i, 'tgt')}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    removeStroke(s.i)
                  }}
                />
              </g>
            )
          })}

          <defs>
            <marker
              id="cw-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="rgba(255,120,80,0.95)" />
            </marker>
          </defs>
        </svg>
      </div>

      {/* selected-stroke controls */}
      {cur ? (
        <div className="flex w-full flex-col gap-2">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1.5 text-foreground">
              <span
                className="size-2.5 rounded-full"
                style={{ background: chromaCss(cur.tgt.cx, cur.tgt.cy) }}
              />
              Stroke {cur.i + 1}
            </span>
            <button
              type="button"
              onClick={() => removeStroke(cur.i)}
              className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
              title="Delete stroke"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
          <Slider
            label="Chroma Range"
            value={cur.range}
            min={0.02}
            max={1.5}
            step={0.01}
            onChange={(v) => set(cur.i, 'r', v)}
            fmt={(v) => v.toFixed(2)}
          />
          <Slider
            label="Exposure"
            value={cur.exposure}
            min={-1}
            max={1}
            step={0.01}
            onChange={(v) => set(cur.i, 'e', v)}
            fmt={(v) => (v >= 0 ? '+' : '') + v.toFixed(2)}
          />
        </div>
      ) : (
        <div className="flex h-5 items-center gap-1 text-[10px] text-muted-foreground">
          <Plus className="size-3" />
          {count < CHROMA_PT_MAX
            ? 'Drag on the disk to add a stroke (source → target)'
            : `Max ${CHROMA_PT_MAX} strokes`}
        </div>
      )}

      {/* global tonal range */}
      <div className="flex w-full flex-col gap-2 border-t border-border pt-2">
        <span className="text-[10px] text-muted-foreground">Tonal Range</span>
        <Slider
          label="Low"
          value={tlo}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => onChange({ cw_tlo: round3(v) })}
          fmt={(v) => v.toFixed(2)}
        />
        <Slider
          label="High"
          value={thi}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => onChange({ cw_thi: round3(v) })}
          fmt={(v) => v.toFixed(2)}
        />
        <Slider
          label="Pivot"
          value={tpv}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => onChange({ cw_tpv: round3(v) })}
          fmt={(v) => v.toFixed(2)}
        />
      </div>
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  fmt,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  fmt: (v: number) => string
}) {
  return (
    <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
      <span className="w-20 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer accent-foreground"
      />
      <span className="w-10 shrink-0 text-right font-mono tabular-nums text-foreground">
        {fmt(value)}
      </span>
    </label>
  )
}
