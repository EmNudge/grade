// Shared project open/save logic, used both by the Project submenu and by the
// editor shell's restore-on-load prompt. The handle of the file backing the
// current project lives at module scope so save-in-place works no matter which
// component triggered the last open/save (the menu mounts lazily; the restore
// prompt runs at startup).

import { useCallback } from 'react'
import { toast } from 'sonner'
import { ensureReadPermission, getClipHandle } from './clip-handles'
import { buildProject, parseProject, projectFilename, serializeProject } from './project'
import {
  type RecentProject,
  forgetRecentProject,
  listRecentProjects,
  rememberRecentProject,
} from './recent-projects'
import { type SaveTarget, pickOpenFile, pickSaveFile, writeSaveFile } from './save-file'
import { useEditor } from './store'

const PROJECT_ACCEPT = {
  description: 'Grade project',
  accept: { 'application/json': ['.grade'] },
}

// The file backing the current project, for "Save" (overwrite in place).
let currentProjectHandle: FileSystemFileHandle | null = null

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface ProjectActions {
  open: () => Promise<void>
  save: () => Promise<void>
  saveAs: () => Promise<void>
  openRecent: (rp: RecentProject) => Promise<void>
  /** On startup, offer to reopen the most recently used project. */
  restoreLast: () => Promise<void>
}

export function useProjectActions(): ProjectActions {
  const getTemplate = useEditor((s) => s.getTemplate)
  const applyTemplate = useEditor((s) => s.applyTemplate)
  const setClipFps = useEditor((s) => s.setClipFps)
  const setPendingClip = useEditor((s) => s.setPendingClip)

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

  // Apply a parsed project (+ optional handle for save-in-place and recents),
  // then offer to bring back its footage if it isn't already loaded.
  const loadProject = useCallback(
    async (file: File, handle: FileSystemFileHandle | null) => {
      const project = parseProject(await file.text())
      const positions = Array.isArray(project.positions) ? project.positions : undefined
      applyTemplate(project.graph, positions)
      if (project.clipFps != null) setClipFps(project.clipFps)
      currentProjectHandle = handle
      if (handle) void rememberRecentProject(handle)

      const { clipName } = useEditor.getState()
      const needsClip = project.clipName && project.clipName !== clipName
      if (!needsClip) {
        toast.success(`Opened ${file.name}`)
        return
      }
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

  const open = useCallback(async () => {
    const picked = await pickOpenFile(PROJECT_ACCEPT)
    if (!picked) return // user cancelled
    try {
      await loadProject(picked.file, picked.handle)
    } catch (err) {
      toast.error('Could not open project', { description: messageOf(err) })
    }
  }, [loadProject])

  const writeProject = useCallback(
    async (target: SaveTarget) => {
      const { nodes, clipName, clipFps } = useEditor.getState()
      // Positions align to getTemplate()'s node order (both read store.nodes).
      const positions = nodes.map((n) => ({ x: n.position.x, y: n.position.y }))
      const project = buildProject(getTemplate(), positions, { name: clipName, fps: clipFps })
      const blob = new Blob([serializeProject(project)], { type: 'application/json' })
      await writeSaveFile(target, blob)
      currentProjectHandle = target.handle
      if (target.handle) void rememberRecentProject(target.handle)
      toast.success(`Saved ${target.filename}`)
    },
    [getTemplate],
  )

  const saveAs = useCallback(async () => {
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
  }, [writeProject])

  const save = useCallback(async () => {
    // No backing handle yet (or the download fallback): fall back to Save As.
    const handle = currentProjectHandle
    if (!handle) return saveAs()
    try {
      await writeProject({ handle, filename: handle.name })
    } catch (err) {
      toast.error('Could not save project', { description: messageOf(err) })
    }
  }, [writeProject, saveAs])

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
        void forgetRecentProject(rp.name)
      }
    },
    [loadProject],
  )

  const restoreLast = useCallback(async () => {
    const [last] = await listRecentProjects()
    if (!last) return
    toast('Restore last project?', {
      description: last.name,
      duration: 8000,
      action: { label: 'Restore', onClick: () => void openRecent(last) },
    })
  }, [openRecent])

  return { open, save, saveAs, openRecent, restoreLast }
}
