import { Camera, X } from 'lucide-react'
import { toast } from 'sonner'
import { useEditor } from '../../editor/store'

/**
 * The Stills bin — captured reference frames, shown in the media pool's Stills
 * tab so they're always reachable (not just when one exists). Hovering a still
 * previews that frame over the canvas (wired in the Viewer via `hoveredStillId`).
 * "Capture" grabs the current graded frame.
 */
export function StillsGallery() {
  const stills = useEditor((s) => s.stills)
  const removeStill = useEditor((s) => s.removeStill)
  const setHoveredStill = useEditor((s) => s.setHoveredStill)
  const captureStill = useEditor((s) => s.captureStill)

  const onCapture = async () => {
    if (await captureStill()) toast.success('Still captured')
    else toast.error('No frame to capture yet')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-2">
        <button
          type="button"
          onClick={() => void onCapture()}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/80"
        >
          <Camera className="size-3.5" /> Capture still
        </button>
      </div>
      {stills.length === 0 ? (
        <p className="px-3 pt-1 text-[11px] leading-relaxed text-muted-foreground">
          No stills yet. Capture the current frame, or right-click the viewer.
        </p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto px-2 pb-2">
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
      )}
    </div>
  )
}
