import { useState } from 'react'
import type { NodeDef, ParamDef } from '@grade/nodes'
import { Plus, X } from 'lucide-react'
import { registry } from '../../editor/registry'
import { type FxInstance, type NodeValues, useEditor } from '../../editor/store'
import { ColorWheels } from './color-wheels'
import { CurveEditor } from './curve-editor'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { Label } from '../ui/label'
import { NativeSelect, NativeSelectOption } from '../ui/native-select'
import { Slider } from '../ui/slider'
import { Switch } from '../ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'

/** "FX" or "FX (Color Space Transform, Glow)" — comma-joined, length-capped. */
function fxTabLabel(extra: FxInstance[]): string {
  if (extra.length === 0) return 'FX'
  const names = extra.map((f) => registry.get(f.type)?.label ?? f.type)
  let joined = names.join(', ')
  const MAX = 28
  if (joined.length > MAX) joined = `${joined.slice(0, MAX - 1).trimEnd()}…`
  return `FX (${joined})`
}

export function Inspector() {
  const node = useEditor((s) => s.nodes.find((n) => n.id === s.selectedId))
  const updateFxValues = useEditor((s) => s.updateFxValues)
  const addFx = useEditor((s) => s.addFx)
  const removeFx = useEditor((s) => s.removeFx)
  const [tab, setTab] = useState<'base' | 'fx'>('base')

  if (!node || node.data.role !== 'effect') {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Select a corrector node to edit it.
      </div>
    )
  }

  const fxDefs = registry.list().filter((d) => d.fx)
  const fxList = node.data.fx
  const baseFx = fxList.find((f) => f.base) ?? fxList[0]
  const extraFx = fxList.filter((f) => !f.base)
  const baseLabel = registry.get(baseFx?.type ?? 'color-correct')?.label ?? 'Lift / Gamma / Gain'

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as 'base' | 'fx')}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      {/* Two master tabs: the base corrector, and an FX bin. */}
      <div className="border-b border-border px-2 py-1.5">
        <TabsList variant="line" className="h-auto flex-wrap justify-start gap-1">
          <TabsTrigger value="base">{baseLabel}</TabsTrigger>
          <TabsTrigger value="fx" className="min-w-0 max-w-[220px] justify-start">
            <span className="truncate">{fxTabLabel(extraFx)}</span>
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="base" className="min-h-0 flex-1 overflow-y-auto">
        {baseFx && (
          <FxPanel fx={baseFx} onChange={(patch) => updateFxValues(node.id, baseFx.id, patch)} />
        )}
      </TabsContent>

      <TabsContent value="fx" className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="sm" variant="secondary" className="h-7 gap-1.5 self-start" />}
            >
              <Plus className="size-3.5" /> Add FX
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuGroup>
                {fxDefs.map((def) => (
                  <DropdownMenuItem key={def.type} onClick={() => addFx(node.id, def.type)}>
                    <span
                      className="mr-2 size-2 rounded-full"
                      style={{ background: def.accent ?? 'currentColor' }}
                    />
                    {def.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {extraFx.length === 0 && (
            <p className="px-1 text-xs text-muted-foreground">
              No effects yet. Add one — they stack and apply in order.
            </p>
          )}
          {extraFx.map((fx) => (
            <FxPanel
              key={fx.id}
              fx={fx}
              onChange={(patch) => updateFxValues(node.id, fx.id, patch)}
              onRemove={() => removeFx(node.id, fx.id)}
            />
          ))}
        </div>
      </TabsContent>
    </Tabs>
  )
}

function FxPanel({
  fx,
  onChange,
  onRemove,
}: {
  fx: FxInstance
  onChange: (patch: NodeValues) => void
  onRemove?: () => void
}) {
  const def = registry.get(fx.type)
  if (!def) return null

  // Base corrector: render bare (it owns the whole tab).
  if (fx.type === 'color-correct') {
    return (
      <Tabs defaultValue="wheels" className="flex flex-col gap-0 p-2">
        <TabsList variant="line" className="mb-1 self-start">
          <TabsTrigger value="wheels">Wheels</TabsTrigger>
          <TabsTrigger value="curves">Curves</TabsTrigger>
        </TabsList>
        <TabsContent value="wheels">
          <ColorWheels def={def} values={fx.values} onChange={onChange} />
        </TabsContent>
        <TabsContent value="curves" className="p-2">
          <CurveEditor values={fx.values} onChange={onChange} />
        </TabsContent>
      </Tabs>
    )
  }

  // Stacked FX: a labelled card with its own remove control.
  return (
    <div className="rounded-md border border-border bg-background/40">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ background: def.accent ?? 'var(--muted-foreground)' }}
        />
        <span className="text-xs font-medium">{def.label}</span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="ml-auto text-muted-foreground transition-colors hover:text-destructive"
            title="Remove FX"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <FxParams def={def} values={fx.values} onChange={onChange} />
    </div>
  )
}

/** Generic param controls (sliders / selects / switches) for non-corrector FX. */
function FxParams({
  def,
  values,
  onChange,
}: {
  def: NodeDef
  values: NodeValues
  onChange: (patch: NodeValues) => void
}) {
  return (
    <div className="flex flex-col gap-4 p-3">
      {def.params.map((p) => (
        <Control key={p.key} p={p} value={values[p.key]} onChange={onChange} />
      ))}
    </div>
  )
}

function Control({
  p,
  value,
  onChange,
}: {
  p: ParamDef
  value: number | string | boolean | undefined
  onChange: (patch: NodeValues) => void
}) {
  if (p.type === 'float') {
    const v = typeof value === 'number' ? value : Number(p.default)
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs">{p.label}</Label>
          <span className="font-mono text-[11px] text-muted-foreground">{v.toFixed(3)}</span>
        </div>
        <Slider
          value={[v]}
          min={p.min ?? 0}
          max={p.max ?? 1}
          step={p.step ?? 0.01}
          onValueChange={(next) =>
            onChange({ [p.key]: Array.isArray(next) ? next[0] : (next as number) })
          }
        />
      </div>
    )
  }
  if (p.type === 'enum') {
    return (
      <div className="flex flex-col gap-2">
        <Label className="text-xs">{p.label}</Label>
        <NativeSelect
          className="w-full"
          value={String(value ?? p.default)}
          onChange={(e) => onChange({ [p.key]: e.target.value })}
        >
          {(p.options ?? []).map((o) => (
            <NativeSelectOption key={o.value} value={o.value}>
              {o.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-between">
      <Label className="text-xs">{p.label}</Label>
      <Switch checked={Boolean(value)} onCheckedChange={(c) => onChange({ [p.key]: c })} />
    </div>
  )
}
