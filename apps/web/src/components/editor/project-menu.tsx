import { useCallback, useEffect, useRef, useState } from 'react'
import { FileDown, FolderOpen, FolderUp, Save, X } from 'lucide-react'
import { toast } from 'sonner'
import { ensureReadPermission, getClipHandle } from '../../editor/clip-handles'
import { buildProject, parseProject, projectFilename, serializeProject } from '../../editor/project'
import {
  type RecentProject,
  forgetRecentProject,
  listRecentProjects,
  rememberRecentProject,
} from '../../editor/recent-projects'
import { type SaveTarget, pickOpenFile, pickSaveFile, writeSaveFile } from '../../editor/save-file'
import { useEditor } from '../../editor/store'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'

const PROJECT_ACCEPT = {
  description: 'Grade project',
  accept: { 'application/json': ['.grade'] },
}

/**
 * Open and save `.grade` project files — the node graph plus a reference to the
 * clip it was graded against. When the browser supports the File System Access
 * API, "Save" overwrites the file opened/saved this session in place, recently
 * used projects are listed for one-click reopening, and the last one can be
 * restored on load. Otherwise each save downloads a fresh copy.
 */
export function ProjectMenu() {
  const getTemplate = useEditor((s) => s.getTemplate)
  const applyTemplate = useEditor((s) => s.applyTemplate)
  const setClipFps = useEditor((s) => s.setClipFps)
  const setPendingClip = useEditor((s) => s.setPendingClip)
  // Handle of the file backing the current project, for save-in-place.
  const handleRef = useRef<FileSystemFileHandle | null>(null)
  const [recents, setRecents] = useState<RecentProject[]>([])
  const restoredRef = useRef(false)

  const refreshRecents = useCallback(() => void listRecentProjects().then(setRecents), [])

  const reloadClip = useCallback(
    async (handle: FileSystemFileHandle) => {
      try {
        if (!(await ensureReadPermission(handle))) {
          toast.error('Permission to read the clip was denied.')
          return
        }
        setPendingClip(await handle.getFile())
      } catch (err) {
        toast.error('Could not reload footage', { description: messageOf(err) })
      }
    },
    [setPendingClip],
  )

  // Apply a parsed project from a file (+ optional handle for save-in-place and
  // recents), then offer to bring back its footage if it isn't already loaded.
  const loadProject = useCallback(
    async (file: File, handle: FileSystemFileHandle | null) => {
      const project = parseProject(await file.text())
      const positions = Array.isArray(project.positions) ? project.positions : undefined
      applyTemplate(project.graph, positions)
      if (project.clipFps != null) setClipFps(project.clipFps)
      handleRef.current = handle
      if (handle) void rememberRecentProject(handle)

      const { clipName } = useEditor.getState()
      const needsClip = project.clipName && project.clipName !== clipName
      if (!needsClip) {
        toast.success(`Opened ${file.name}`)
        return
      }
      // Offer a one-click reload if we still hold a handle for this footage.
      const clipHandle = await getClipHandle(project.clipName!)
      toast.success(`Opened ${file.name}`, {
        description: clipHandle
          ? `Reload “${project.clipName}” to see this grade on its footage.`
          : `Load “${project.clipName}” to see this grade on its footage.`,
        ...(clipHandle
          ? { action: { label: 'Reload footage', onClick: () => void reloadClip(clipHandle) } }
          : {}),
      })
    },
    [applyTemplate, setClipFps, reloadClip],
  )

  const openRecent = useCallback(
    async (rp: RecentProject) => {
      try {
        if (!(await ensureReadPermission(rp.handle))) {
          toast.error('Permission to read the project was denied.')
          return
        }
        await loadProject(await rp.handle.getFile(), rp.handle)
      } catch (err) {
        // The file was likely moved or deleted — drop the stale entry.
        toast.error('Could not open project', { description: messageOf(err) })
        void forgetRecentProject(rp.name).then(refreshRecents)
      }
    },
    [loadProject, refreshRecents],
  )

  // On first mount, offer to restore the most recently used project.
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    void (async () => {
      const [last] = await listRecentProjects()
      if (!last) return
      toast('Restore last project?', {
        description: last.name,
        duration: 8000,
        action: { label: 'Restore', onClick: () => void openRecent(last) },
      })
    })()
  }, [openRecent])

  const writeProject = async (target: SaveTarget) => {
    const { nodes, clipName, clipFps } = useEditor.getState()
    // Positions align to getTemplate()'s node order (both read store.nodes).
    const positions = nodes.map((n) => ({ x: n.position.x, y: n.position.y }))
    const project = buildProject(getTemplate(), positions, { name: clipName, fps: clipFps })
    const blob = new Blob([serializeProject(project)], { type: 'application/json' })
    await writeSaveFile(target, blob)
    handleRef.current = target.handle
    if (target.handle) void rememberRecentProject(target.handle)
    toast.success(`Saved ${target.filename}`)
  }

  const saveAs = async () => {
    const { clipName } = useEditor.getState()
    const target = await pickSaveFile({
      suggestedName: projectFilename(clipName),
      ...PROJECT_ACCEPT,
    })
    if (!target) return // user cancelled
    try {
      await writeProject(target)
    } catch (err) {
      toast.error('Could not save project', { description: messageOf(err) })
    }
  }

  const save = async () => {
    // No backing handle yet (or the download fallback): fall back to Save As.
    if (!handleRef.current) return saveAs()
    try {
      await writeProject({ handle: handleRef.current, filename: handleRef.current.name })
    } catch (err) {
      toast.error('Could not save project', { description: messageOf(err) })
    }
  }

  const open = async () => {
    const picked = await pickOpenFile(PROJECT_ACCEPT)
    if (!picked) return // user cancelled
    try {
      await loadProject(picked.file, picked.handle)
    } catch (err) {
      toast.error('Could not open project', { description: messageOf(err) })
    }
  }

  const onForget = (e: React.MouseEvent, rp: RecentProject) => {
    e.stopPropagation()
    void forgetRecentProject(rp.name).then(refreshRecents)
  }

  return (
    <DropdownMenu onOpenChange={(isOpen) => isOpen && refreshRecents()}>
      <DropdownMenuTrigger
        render={<Button size="sm" variant="ghost" className="h-7 gap-1.5" />}
        title="Project files"
      >
        <FolderOpen className="size-4" /> Project
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={open}>
            <FolderUp className="mr-2 size-3.5" /> Open project…
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={save}>
            <Save className="mr-2 size-3.5" /> Save project
          </DropdownMenuItem>
          <DropdownMenuItem onClick={saveAs}>
            <FileDown className="mr-2 size-3.5" /> Save project as…
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {recents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Recent</DropdownMenuLabel>
            <DropdownMenuGroup>
              {recents.map((rp) => (
                <DropdownMenuItem
                  key={rp.name}
                  onClick={() => void openRecent(rp)}
                  className="group/item justify-between gap-2"
                >
                  <span className="truncate">{rp.name}</span>
                  <button
                    type="button"
                    onClick={(e) => onForget(e, rp)}
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/item:opacity-100"
                    aria-label={`Remove ${rp.name} from recents`}
                  >
                    <X className="size-3.5" />
                  </button>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
