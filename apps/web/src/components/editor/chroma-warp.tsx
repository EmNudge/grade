import { CHROMA_HUES } from '@grade/nodes'
import { RotateCcw } from 'lucide-react'
import type { NodeValues } from '../../editor/store'
import { Slider } from '../ui/slider'

function num(v: unknown, fallback: number) {
  return typeof v === 'number' ? v : fallback
}

/**
 * Chroma Warp — per-hue hue-shift + saturation around the colour wheel
 * (hue-vs-hue / hue-vs-sat, like Resolve's Color Warper). Drives the shader's
 * cw_* params on the corrector.
 */
export function ChromaWarp({
  values,
  onChange,
}: {
  values: NodeValues
  onChange: (patch: NodeValues) => void
}) {
  const reset = () => {
    const patch: NodeValues = {}
    for (const h of CHROMA_HUES) {
      patch[`cw_h_${h.key}`] = 0
      patch[`cw_s_${h.key}`] = 1
    }
    onChange(patch)
  }

  return (
    <div className="flex flex-col gap-3 p-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">Hue shift · Saturation per hue</span>
        <button
          type="button"
          onClick={reset}
          className="text-muted-foreground transition-colors hover:text-foreground"
          title="Reset chroma warp"
        >
          <RotateCcw className="size-3.5" />
        </button>
      </div>

      {CHROMA_HUES.map((h) => {
        const hue = num(values[`cw_h_${h.key}`], 0)
        const sat = num(values[`cw_s_${h.key}`], 1)
        return (
          <div key={h.key} className="flex items-center gap-2">
            <span
              className="size-4 shrink-0 rounded-full ring-1 ring-inset ring-black/30"
              style={{ background: h.color }}
              title={h.label}
            />
            <div className="grid flex-1 grid-cols-2 gap-x-3 gap-y-1">
              <Slider
                value={[hue]}
                min={-1}
                max={1}
                step={0.01}
                onValueChange={(n) =>
                  onChange({ [`cw_h_${h.key}`]: Array.isArray(n) ? n[0] : (n as number) })
                }
              />
              <Slider
                value={[sat]}
                min={0}
                max={2}
                step={0.01}
                onValueChange={(n) =>
                  onChange({ [`cw_s_${h.key}`]: Array.isArray(n) ? n[0] : (n as number) })
                }
              />
            </div>
          </div>
        )
      })}
      <div className="grid grid-cols-2 gap-x-3 pl-6 text-[10px] text-muted-foreground">
        <span className="text-center">Hue</span>
        <span className="text-center">Sat</span>
      </div>
    </div>
  )
}
