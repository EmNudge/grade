import { Film, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { pickAndAddClip } from '../../editor/import-clip'
import { useEditor } from '../../editor/store'
import { StillsGallery } from './stills-gallery'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'

/**
 * The media "Space" to the left of the editor: a pool of Clips (each carrying
 * its own node graph) and the Stills bin. Clicking a clip swaps the footage and
 * its grade; importing adds a new clip (replacing the old viewer "Replace"
 * button). Always visible, so stills are discoverable.
 */
export function MediaPool() {
  const [tab, setTab] = useState<'clips' | 'stills'>('clips')

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as 'clips' | 'stills')}
      className="flex h-full w-44 shrink-0 flex-col gap-0 border-r border-border bg-card"
    >
      <div className="border-b border-border px-2 py-1.5">
        <TabsList variant="line" className="h-auto w-full justify-start gap-1">
          <TabsTrigger value="clips" className="flex-none">
            Clips
          </TabsTrigger>
          <TabsTrigger value="stills" className="flex-none">
            Stills
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="clips" className="min-h-0 flex-1 overflow-hidden">
        <ClipsBin />
      </TabsContent>
      <TabsContent value="stills" className="min-h-0 flex-1 overflow-hidden">
        <StillsGallery />
      </TabsContent>
    </Tabs>
  )
}

function ClipsBin() {
  const clips = useEditor((s) => s.clips)
  const activeClipId = useEditor((s) => s.activeClipId)
  const selectClip = useEditor((s) => s.selectClip)
  const removeClip = useEditor((s) => s.removeClip)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-2">
        <button
          type="button"
          onClick={() => void pickAndAddClip()}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/80"
        >
          <Plus className="size-3.5" /> Import clip
        </button>
      </div>
      {clips.length === 0 ? (
        <p className="px-3 pt-1 text-[11px] leading-relaxed text-muted-foreground">
          No clips yet. Import footage — each clip keeps its own node graph.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {clips.map((clip) => (
            <div
              key={clip.id}
              className={`group relative overflow-hidden rounded border transition-colors ${
                clip.id === activeClipId
                  ? 'border-primary ring-1 ring-primary'
                  : 'border-border hover:border-primary/60'
              }`}
            >
              <button
                type="button"
                onClick={() => selectClip(clip.id)}
                title={clip.name}
                className="block w-full cursor-pointer text-left"
              >
                <span className="flex aspect-video items-center justify-center bg-black">
                  {clip.thumbnail ? (
                    <img
                      src={clip.thumbnail}
                      alt=""
                      className="size-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <Film className="size-5 text-muted-foreground" />
                  )}
                </span>
                <span className="block truncate px-1.5 py-1 text-[10px] text-muted-foreground">
                  {clip.name}
                </span>
              </button>
              <button
                type="button"
                onClick={() => removeClip(clip.id)}
                className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white/80 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                aria-label="Remove clip"
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
