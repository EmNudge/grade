// Persist FileSystemFileHandles for footage, keyed by clip name, so a project
// can re-open the same clip across sessions without the user re-picking it.
// Handles are structured-cloneable and persist directly; the browser still
// gates the bytes behind a permission re-grant (see `ensureReadPermission`,
// which must run inside a user gesture).

import { idbGet, idbPut } from './idb'

const STORE = 'clip-handles'

/** Remember the handle for a clip, keyed by its file name. Best-effort. */
export async function putClipHandle(name: string, handle: FileSystemFileHandle): Promise<void> {
  try {
    await idbPut(STORE, name, handle)
  } catch {
    // Persisting is a nicety; never let it break clip loading.
  }
}

/** Look up a previously saved handle for a clip name, or null if none/unavailable. */
export async function getClipHandle(name: string): Promise<FileSystemFileHandle | null> {
  try {
    return (await idbGet<FileSystemFileHandle>(STORE, name)) ?? null
  } catch {
    return null
  }
}

// `queryPermission`/`requestPermission` aren't in the DOM lib yet.
type PermissionState = 'granted' | 'denied' | 'prompt'
interface PermissionedHandle {
  queryPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
}

/** Ensure read access to a stored handle, prompting if needed. Call from a gesture. */
export async function ensureReadPermission(handle: FileSystemFileHandle): Promise<boolean> {
  const h = handle as FileSystemFileHandle & PermissionedHandle
  const opts = { mode: 'read' as const }
  if ((await h.queryPermission?.(opts)) === 'granted') return true
  return (await h.requestPermission?.(opts)) === 'granted'
}
