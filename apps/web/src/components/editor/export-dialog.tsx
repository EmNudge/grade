import { useState } from 'react'
import { Download } from 'lucide-react'
import { formatFps } from '../../editor/detect-fps'
import type { ExportFormat, ExportQuality } from '../../editor/export'
import { useExport } from '../../editor/use-export'
import { useEditor } from '../../editor/store'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Label } from '../ui/label'
import { NativeSelect, NativeSelectOption } from '../ui/native-select'
import { Progress } from '../ui/progress'

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'mp4', label: 'MP4 · H.264' },
  { value: 'webm', label: 'WebM · VP9' },
]
const QUALITIES: { value: ExportQuality; label: string }[] = [
  { value: 'low', label: 'Low — smaller file' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High — best quality' },
]
const FRAME_RATES = [24, 25, 30, 60]
const SOURCE = 'source'
/** Fallback fps when the source rate couldn't be detected. */
const SOURCE_FALLBACK = 30

export function ExportDialog() {
  const [open, setOpen] = useState(false)
  const hasClip = useEditor((s) => s.video !== null)
  const clipFps = useEditor((s) => s.clipFps)
  const { phase, progress, error, supported, run, cancel } = useExport()

  const [format, setFormat] = useState<ExportFormat>('mp4')
  const [quality, setQuality] = useState<ExportQuality>('high')
  // 'source' tracks the clip's own frame rate; otherwise a fixed numeric rate.
  const [fpsChoice, setFpsChoice] = useState<string>(SOURCE)
  const [audio, setAudio] = useState(true)

  const busy = phase === 'exporting'

  const onExport = () => {
    const fps = fpsChoice === SOURCE ? (clipFps ?? SOURCE_FALLBACK) : Number(fpsChoice)
    void run({ format, quality, fps, audio })
  }

  const sourceLabel = clipFps ? `Source — ${formatFps(clipFps)} fps` : 'Source'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return // don't dismiss mid-export; use Cancel
        setOpen(next)
      }}
    >
      {/* The Button has `disabled:pointer-events-none`, so a native title on it
          won't show while disabled. Carry the "why" on a wrapper span instead. */}
      <span className="inline-flex" title={hasClip ? undefined : 'Import a clip first'}>
        <Button
          size="sm"
          variant="default"
          className="h-7 gap-1.5"
          disabled={!hasClip}
          title={hasClip ? 'Export graded video' : undefined}
          onClick={() => setOpen(true)}
        >
          <Download className="size-4" /> Export
        </Button>
      </span>

      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Export graded video</DialogTitle>
          <DialogDescription>
            Renders every frame through the node graph on the GPU and encodes the result.
          </DialogDescription>
        </DialogHeader>

        {!supported ? (
          <p className="text-destructive">
            This browser doesn’t support WebCodecs video export. Try Chrome or Edge.
          </p>
        ) : (
          <div className="grid gap-3">
            <Field label="Format">
              <NativeSelect
                size="sm"
                value={format}
                disabled={busy}
                onChange={(e) => setFormat(e.target.value as ExportFormat)}
              >
                {FORMATS.map((f) => (
                  <NativeSelectOption key={f.value} value={f.value}>
                    {f.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>

            <Field label="Quality">
              <NativeSelect
                size="sm"
                value={quality}
                disabled={busy}
                onChange={(e) => setQuality(e.target.value as ExportQuality)}
              >
                {QUALITIES.map((q) => (
                  <NativeSelectOption key={q.value} value={q.value}>
                    {q.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>

            <Field label="Frame rate">
              <NativeSelect
                size="sm"
                value={fpsChoice}
                disabled={busy}
                onChange={(e) => setFpsChoice(e.target.value)}
              >
                <NativeSelectOption value={SOURCE}>{sourceLabel}</NativeSelectOption>
                {FRAME_RATES.map((r) => (
                  <NativeSelectOption key={r} value={String(r)}>
                    {r} fps
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>

            <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
              <Label className="text-xs text-muted-foreground" htmlFor="export-audio">
                Audio
              </Label>
              {/* oxlint-disable-next-line jsx-a11y/label-has-associated-control -- label wraps the Checkbox control; the custom component hides the association from the linter */}
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <Checkbox
                  id="export-audio"
                  checked={audio}
                  disabled={busy}
                  onCheckedChange={(v) => setAudio(v)}
                />
                Include source audio
              </label>
            </div>

            {busy && (
              <div className="grid gap-1.5">
                <Progress value={Math.round(progress * 100)} />
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  Encoding… {Math.round(progress * 100)}%
                </span>
              </div>
            )}

            {phase === 'error' && error && <p className="text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {busy ? (
            <Button variant="outline" size="sm" onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button size="sm" className="gap-1.5" disabled={!supported} onClick={onExport}>
                <Download className="size-4" />
                {phase === 'done' ? 'Export again' : 'Export'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="[&_[data-slot=native-select-wrapper]]:w-full">{children}</div>
    </div>
  )
}
