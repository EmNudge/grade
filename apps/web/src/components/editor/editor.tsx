import { ReactFlowProvider } from '@xyflow/react'
import { Redo2, Undo2 } from 'lucide-react'
import { useEditor } from '../../editor/store'
import { useShortcuts } from '../../editor/use-shortcuts'
import { CommandPalette } from './command-palette'
import { ExportDialog } from './export-dialog'
import { Inspector } from './inspector'
import { NodeGraph } from './node-graph'
import { Scopes } from './scopes'
import { Viewer } from './viewer'
import { Button } from '../ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable'
import { Toaster } from '../ui/sonner'

/**
 * The Grade editor shell — DaVinci color-page layout:
 *   top:    viewer (left)  |  node graph (right)
 *   bottom: corrector / color wheels (left)  |  scopes pinned (right)
 * WebGPU + React Flow are client-only, so this renders only after mount
 * (see routes/index.tsx).
 */
export function Editor() {
  useShortcuts()
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  return (
    <ReactFlowProvider>
      <CommandPalette />
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <header className="flex items-center gap-2 border-b border-border px-4 py-2">
          <span className="size-3 rounded-sm bg-primary" />
          <span className="text-sm font-semibold tracking-tight">Grade</span>
          <span className="text-xs text-muted-foreground">node-based color</span>
          <div className="ml-3 flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={!canUndo}
              onClick={undo}
              title="Undo (⌘Z)"
              aria-label="Undo"
            >
              <Undo2 className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={!canRedo}
              onClick={redo}
              title="Redo (⌘⇧Z)"
              aria-label="Redo"
            >
              <Redo2 className="size-4" />
            </Button>
          </div>
          <span className="ml-auto hidden text-[11px] text-muted-foreground md:inline">
            Space play · ⌘K palette · ⌘Z undo · ⌥S/⇧S add · ⌘D bypass · ⌫ delete
          </span>
          <div className="ml-auto md:ml-3">
            <ExportDialog />
          </div>
        </header>

        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
          {/* Top: viewer left, node graph right */}
          <ResizablePanel defaultSize="56%" minSize="25%">
            <ResizablePanelGroup orientation="horizontal">
              <ResizablePanel defaultSize="52%" minSize="30%">
                <Viewer />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize="48%" minSize="25%">
                <NodeGraph />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Bottom: corrector / color wheels left, scopes pinned right */}
          <ResizablePanel defaultSize="44%" minSize="20%">
            <ResizablePanelGroup orientation="horizontal">
              <ResizablePanel defaultSize="68%" minSize="35%">
                <div className="h-full border-t border-border bg-card">
                  <Inspector />
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize="32%" minSize="20%">
                <div className="h-full border-l border-t border-border bg-card">
                  <Scopes />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <Toaster />
    </ReactFlowProvider>
  )
}
