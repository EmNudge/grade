import { useEffect, useRef } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { ChevronDown, Redo2, Undo2 } from 'lucide-react'
import { useEditor } from '../../editor/store'
import { useProjectActions } from '../../editor/use-project-actions'
import { useShortcuts } from '../../editor/use-shortcuts'
import { CommandPalette } from './command-palette'
import { ExportDialog } from './export-dialog'
import { Inspector } from './inspector'
import { NodeGraph } from './node-graph'
import { ProjectMenu } from './project-menu'
import { Scopes } from './scopes'
import { TemplatesMenu } from './templates-menu'
import { Viewer } from './viewer'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
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
  const { restoreLast } = useProjectActions()

  // On startup, offer to reopen the most recently used project. Lives here (an
  // always-mounted shell) rather than in the Project menu, which mounts lazily.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    void restoreLast()
  }, [restoreLast])

  return (
    <ReactFlowProvider>
      <CommandPalette />
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <header className="flex items-center gap-2 border-b border-border px-4 py-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2" />}
              title="Grade menu"
            >
              <span className="size-3 rounded-sm bg-primary" />
              <span className="text-sm font-semibold tracking-tight">Grade</span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
              <DropdownMenuItem disabled={!canUndo} onClick={undo}>
                <Undo2 className="mr-2 size-3.5" /> Undo
                <DropdownMenuShortcut>⌘Z</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canRedo} onClick={redo}>
                <Redo2 className="mr-2 size-3.5" /> Redo
                <DropdownMenuShortcut>⌘⇧Z</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <ProjectMenu />
              <TemplatesMenu />
            </DropdownMenuContent>
          </DropdownMenu>
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
