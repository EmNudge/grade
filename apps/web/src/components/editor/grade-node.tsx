import { InfoDecorator } from './info-decorator'
import { Handle, type NodeProps, Position } from '@xyflow/react'
import { registry } from '../../editor/registry'
import { type GradeNode as GradeNodeType, useEditor } from '../../editor/store'
import { cn } from '../../lib/utils'

const handleClass = '!size-3 !border-2 !border-background !bg-muted-foreground'
const CORRECTOR_ACCENT = '#f59e0b'

/** Custom React Flow node: effect nodes are corrector cards; I/O nodes are pills. */
export function GradeNodeView({ id, data }: NodeProps<GradeNodeType>) {
  const selectedId = useEditor((s) => s.selectedId)
  const selectNode = useEditor((s) => s.selectNode)

  // I/O nodes: compact accent pills, not selectable.
  if (data.role !== 'effect') {
    const def = registry.get(data.ioType ?? data.role)
    const accent = def?.accent ?? 'var(--muted-foreground)'
    return (
      <div
        className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium"
        style={{
          borderColor: accent,
          background: `color-mix(in oklch, ${accent} 16%, var(--card))`,
        }}
      >
        <InfoDecorator descKey="grade-node">
          <span className="truncate">{def?.label ?? data.role}</span>
        </InfoDecorator>
        {data.role === 'input' && (
          <Handle type="source" position={Position.Right} className={handleClass} />
        )}
        {data.role === 'output' && (
          <Handle type="target" position={Position.Left} className={handleClass} />
        )}
      </div>
    )
  }

  const selected = selectedId === id
  const disabled = !data.enabled
  // The base Lift/Gamma/Gain corrector is automatic on every node — list only
  // the FX stacked on top of it.
  const fxNames = data.fx.filter((f) => !f.base).map((f) => registry.get(f.type)?.label ?? f.type)

  return (
    <div
      onPointerDown={() => selectNode(id)}
      className={cn(
        'min-w-[180px] rounded-md border bg-card text-card-foreground shadow-sm transition-colors',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border',
        disabled && 'opacity-45',
      )}
    >
      <div
        className="flex items-center gap-2 rounded-t-md px-3 py-1.5 text-xs font-medium"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <span
          className="size-2 shrink-0 rounded-full"
          style={{
            background: disabled ? 'var(--muted-foreground)' : (data.accent ?? CORRECTOR_ACCENT),
          }}
        />
        <InfoDecorator descKey="grade-node">
          <span className={cn('truncate', disabled && 'line-through')}>
            {data.label ?? 'Corrector'}
          </span>
        </InfoDecorator>
        {data.fx.length > 1 && (
          <span className="ml-auto rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
            {data.fx.length} FX
          </span>
        )}
      </div>
      <div className="truncate px-3 py-2 text-[11px] text-muted-foreground">
        {fxNames.length > 0 ? fxNames.join(' · ') : 'No effects'}
      </div>

      <Handle type="target" position={Position.Left} className={handleClass} />
      <Handle type="source" position={Position.Right} className={handleClass} />
    </div>
  )
}
