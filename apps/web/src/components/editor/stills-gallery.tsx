import { X } from 'lucide-react'
import { useEditor } from '../../editor/store'

/**
 * Vertical strip of captured reference stills, shown to the left of the viewer.
 * Hovering a still previews that frame over the canvas (wired in the Viewer via
 * `hoveredStillId`). Only rendered when at least one still exists.
 */
export function StillsGallery() {
  const stills = useEditor((s) => s.stills)
  const removeStill = useEditor((s) => s.removeStill)
  const setHoveredStill = useEditor((s) => s.setHoveredStill)

  if (stills.length === 0) return null

  return (
    <div className="flex h-full w-24 shrink-0 flex-col border-r border-border bg-background">
      <div className="border-b border-border px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
        Stills
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {stills.map((still) => (
          <div
            key={still.id}
            className="group relative cursor-pointer overflow-hidden rounded border border-border transition-colors hover:border-primary"
            onMouseEnter={() => setHoveredStill(still.id)}
            onMouseLeave={() => setHoveredStill(null)}
          >
            <img src={still.url} alt={still.label} className="block w-full" draggable={false} />
            <span className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5 text-[9px] tabular-nums text-white/90">
              {still.label}
            </span>
            <button
              type="button"
              onClick={() => removeStill(still.id)}
              className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white/80 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
              aria-label="Delete still"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
