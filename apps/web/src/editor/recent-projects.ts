// Recently opened/saved `.grade` projects, keyed by file name. Each entry keeps
// the file handle so the project can be reopened in a later session (subject to
// a permission re-grant). The most recent entry doubles as "the last project".

import { idbDelete, idbGetAll, idbPut } from './idb'

const STORE = 'recent-projects'

export interface RecentProject {
  name: string
  handle: FileSystemFileHandle
  savedAt: number
}

/** Record (or bump) a project's recency. Best-effort. */
export async function rememberRecentProject(handle: FileSystemFileHandle): Promise<void> {
  try {
    const entry: RecentProject = { name: handle.name, handle, savedAt: Date.now() }
    await idbPut(STORE, handle.name, entry)
  } catch {
    // Recents are a convenience; never let them break saving/opening.
  }
}

/** Recent projects, most-recent first. */
export async function listRecentProjects(): Promise<RecentProject[]> {
  try {
    const all = await idbGetAll<RecentProject>(STORE)
    return all.toSorted((a, b) => b.savedAt - a.savedAt)
  } catch {
    return []
  }
}

/** Drop a recent entry (e.g. its file was moved or deleted). */
export async function forgetRecentProject(name: string): Promise<void> {
  try {
    await idbDelete(STORE, name)
  } catch {
    // ignore
  }
}
