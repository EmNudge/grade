import { useEffect, useRef, useState } from 'react'
import { parseCubeLut } from '@grade/color'
import type { NodeDef, ParamDef } from '@grade/nodes'
import { Plus, Sparkles, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { type BuiltinLut, BUILTIN_LUTS, loadBuiltinLut } from '../../editor/luts'
import { registry } from '../../editor/registry'
import { type FxInstance, type LoadedLut, type NodeValues, useEditor } from '../../editor/store'
import { ChromaWarp } from './chroma-warp'
import { ColorWheels } from './color-wheels'
import { CurveEditor } from './curve-editor'
import { DESCRIPTIONS } from './descriptions'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuTrigger,
} from '../ui/context-menu'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { NativeSelect, NativeSelectOption } from '../ui/native-select'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
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
  const setFxLut = useEditor((s) => s.setFxLut)
  const addFx = useEditor((s) => s.addFx)
  const removeFx = useEditor((s) => s.removeFx)
  const [tab, setTab] = useState<InspectorTab>('primaries')

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
  const baseDef = baseFx ? registry.get(baseFx.type) : undefined
  const onBase = (patch: NodeValues) => {
    if (baseFx) updateFxValues(node.id, baseFx.id, patch)
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as InspectorTab)}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      {/* One flat tab row: the corrector views on the left, FX bin pinned right. */}
      <div className="border-b border-border px-2 py-1.5">
        <TabsList variant="line" className="h-auto w-full justify-start gap-1">
          <ContextMenu>
            <ContextMenuTrigger render={<TabsTrigger value="primaries" className="flex-none" />}>
              Primaries
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuLabel className="font-medium">About Primaries</ContextMenuLabel>
              <div className="max-w-64 px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
                {DESCRIPTIONS['primaries']}
              </div>
            </ContextMenuContent>
          </ContextMenu>
          <ContextMenu>
            <ContextMenuTrigger render={<TabsTrigger value="hdr" className="flex-none" />}>
              HDR
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuLabel className="font-medium">About HDR</ContextMenuLabel>
              <div className="max-w-64 px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
                {DESCRIPTIONS['hdr']}
              </div>
            </ContextMenuContent>
          </ContextMenu>
          <ContextMenu>
            <ContextMenuTrigger render={<TabsTrigger value="curves" className="flex-none" />}>
              Curves
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuLabel className="font-medium">About Curves</ContextMenuLabel>
              <div className="max-w-64 px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
                {DESCRIPTIONS['curves']}
              </div>
            </ContextMenuContent>
          </ContextMenu>
          <ContextMenu>
            <ContextMenuTrigger render={<TabsTrigger value="chroma" className="flex-none" />}>
              Chroma Warp
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuLabel className="font-medium">About Chroma Warp</ContextMenuLabel>
              <div className="max-w-64 px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
                {DESCRIPTIONS['chroma']}
              </div>
            </ContextMenuContent>
          </ContextMenu>
          <TabsTrigger value="fx" className="ml-auto min-w-0 max-w-[220px] flex-none justify-start">
            <span className="truncate">{fxTabLabel(extraFx)}</span>
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="primaries" className="min-h-0 flex-1 overflow-y-auto">
        {baseDef && baseFx && (
          <ColorWheels def={baseDef} values={baseFx.values} onChange={onBase} mode="primaries" />
        )}
      </TabsContent>
      <TabsContent value="hdr" className="min-h-0 flex-1 overflow-y-auto">
        {baseDef && baseFx && (
          <ColorWheels def={baseDef} values={baseFx.values} onChange={onBase} mode="hdr" />
        )}
      </TabsContent>
      <TabsContent value="curves" className="min-h-0 flex-1 overflow-y-auto p-2">
        {baseFx && (
          <CurveEditor
            values={baseFx.values}
            onChange={onBase}
            histogramSource={`${node.id}:${baseFx.id}`}
          />
        )}
      </TabsContent>
      <TabsContent value="chroma" className="min-h-0 flex-1 overflow-y-auto p-2">
        {baseFx && <ChromaWarp values={baseFx.values} onChange={onBase} />}
      </TabsContent>

      <TabsContent value="fx" className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-2">
          <AddFxMenu defs={fxDefs} onAdd={(type) => addFx(node.id, type)} />

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
              onLut={(lut) => setFxLut(node.id, fx.id, lut)}
              onRemove={() => removeFx(node.id, fx.id)}
            />
          ))}
        </div>
      </TabsContent>
    </Tabs>
  )
}

/** The Inspector's flat tab set: four corrector views plus the FX bin. */
type InspectorTab = 'primaries' | 'hdr' | 'curves' | 'chroma' | 'fx'

/** Searchable "Add FX" menu — type to filter the available effects, click to add. */
function AddFxMenu({ defs, onAdd }: { defs: NodeDef[]; onAdd: (type: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()
  const filtered = q ? defs.filter((d) => d.label.toLowerCase().includes(q)) : defs

  // Focus the search field when the menu opens, without an a11y-flagged autoFocus.
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger
        render={<Button size="sm" variant="secondary" className="h-7 gap-1.5 self-end" />}
      >
        <Plus className="size-3.5" /> Add FX
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 gap-2 p-1.5">
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search effects…"
          className="h-7 text-xs"
        />
        <div className="flex max-h-64 flex-col overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No effects found.</p>
          ) : (
            filtered.map((def) => (
              <button
                key={def.type}
                type="button"
                onClick={() => {
                  onAdd(def.type)
                  setOpen(false)
                  setQuery('')
                }}
                className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: def.accent ?? 'currentColor' }}
                />
                {def.label}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function FxPanel({
  fx,
  onChange,
  onLut,
  onRemove,
}: {
  fx: FxInstance
  onChange: (patch: NodeValues) => void
  onLut?: (lut: LoadedLut | null) => void
  onRemove?: () => void
}) {
  const def = registry.get(fx.type)
  if (!def) return null

  // Stacked FX: a labelled card with its own remove control.
  return (
    <div className="rounded-md border border-border bg-background/40">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ background: def.accent ?? 'var(--muted-foreground)' }}
        />
        <ContextMenu>
          <ContextMenuTrigger render={<span className="text-xs font-medium" />}>
            {def.label}
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuLabel className="font-medium">About {def.label}</ContextMenuLabel>
            <div className="max-w-64 px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
              {DESCRIPTIONS[def.type]}
            </div>
          </ContextMenuContent>
        </ContextMenu>
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
      {def.lut && <LutLoader lut={fx.lut} onLut={onLut} />}
      <FxParams def={def} values={fx.values} onChange={onChange} />
    </div>
  )
}

/** Load / clear a `.cube` 3D LUT for a LUT FX — from a built-in preset or a file. */
function LutLoader({
  lut,
  onLut,
}: {
  lut?: LoadedLut | undefined
  onLut?: ((lut: LoadedLut | null) => void) | undefined
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function onFile(file: File) {
    try {
      const text = await file.text()
      const parsed = parseCubeLut(text)
      const name = parsed.title?.trim() || file.name.replace(/\.cube$/i, '')
      onLut?.({ name, size: parsed.size, data: parsed.data })
      toast.success(`Loaded LUT "${name}"`, { description: `${parsed.size}³ grid` })
    } catch (err) {
      toast.error('Could not load LUT', {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function onPreset(preset: BuiltinLut) {
    setBusy(true)
    try {
      const loaded = await loadBuiltinLut(preset)
      onLut?.(loaded)
      toast.success(`Loaded LUT "${loaded.name}"`, { description: `${loaded.size}³ grid` })
    } catch (err) {
      toast.error('Could not load LUT', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 border-b border-border p-3">
      <input
        ref={inputRef}
        type="file"
        accept=".cube"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void onFile(file)
          e.target.value = '' // allow re-selecting the same file
        }}
      />
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="sm" variant="secondary" className="h-7 gap-1.5" disabled={busy} />
            }
          >
            <Sparkles className="size-3.5" /> Presets
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              {BUILTIN_LUTS.map((preset) => (
                <DropdownMenuItem key={preset.id} onClick={() => void onPreset(preset)}>
                  {preset.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="sm"
          variant="secondary"
          className="h-7 gap-1.5"
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="size-3.5" /> {lut ? 'Replace' : 'Load .cube'}
        </Button>
        {lut && (
          <button
            type="button"
            onClick={() => onLut?.(null)}
            className="text-muted-foreground transition-colors hover:text-destructive"
            title="Clear LUT"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <p className="truncate text-[11px] text-muted-foreground" title={lut?.name}>
        {busy
          ? 'Loading LUT…'
          : lut
            ? `${lut.name} · ${lut.size}³`
            : 'No LUT — pick a preset or load a .cube file.'}
      </p>
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
