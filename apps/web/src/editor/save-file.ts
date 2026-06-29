// Native "Save As" via the File System Access API, with a download fallback.
//
// The picker requires transient user activation, so a long-running task (like a
// multi-second export) must grab the file handle *up front* — synchronously from
// the triggering click, before any await — and stream the finished bytes to it
// later via `writeSaveFile`. Browsers without the API (Firefox, Safari) fall
// back to a regular anchor download at write time.

// The file picker APIs aren't in the DOM lib yet; declare the slice we use.
interface FilePickerType {
  description?: string
  accept: Record<string, string[]>
}
interface SaveFilePickerOptions {
  suggestedName?: string
  types?: FilePickerType[]
}
interface OpenFilePickerOptions {
  types?: FilePickerType[]
  multiple?: boolean
}
declare global {
  interface Window {
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>
    showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>
  }
}

export interface SaveTarget {
  /** Chosen file handle (FSA path), or null when we'll fall back to download. */
  handle: FileSystemFileHandle | null
  /** Name to write/download under. */
  filename: string
}

export interface SavePickOptions {
  suggestedName: string
  /** Accepted MIME → extensions map, e.g. `{ 'video/mp4': ['.mp4'] }`. */
  accept: Record<string, string[]>
  description?: string
}

/** True when the browser can show a native save dialog. */
export function supportsNativeSave(): boolean {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
}

/**
 * Ask the user where to save and return a target to write to. MUST be called
 * within a user gesture (before any long await) so the picker is allowed to open.
 * Returns `null` only when the user explicitly cancels the dialog; if the API is
 * missing or errors otherwise, returns a handle-less target that downloads instead.
 */
export async function pickSaveFile(opts: SavePickOptions): Promise<SaveTarget | null> {
  if (!supportsNativeSave()) {
    return { handle: null, filename: opts.suggestedName }
  }
  try {
    const handle = await window.showSaveFilePicker!({
      suggestedName: opts.suggestedName,
      types: [{ description: opts.description ?? 'File', accept: opts.accept }],
    })
    return { handle, filename: handle.name }
  } catch (err) {
    // AbortError = the user dismissed the dialog: signal cancellation.
    if (err instanceof DOMException && err.name === 'AbortError') return null
    // Otherwise (e.g. SecurityError from a stale gesture): degrade to download.
    return { handle: null, filename: opts.suggestedName }
  }
}

/** Write the finished bytes to the target: stream to disk, or download. */
export async function writeSaveFile(target: SaveTarget, blob: Blob): Promise<void> {
  if (target.handle) {
    const writable = await target.handle.createWritable()
    try {
      await writable.write(blob)
    } finally {
      await writable.close()
    }
    return
  }
  downloadBlob(blob, target.filename)
}

export interface OpenTarget {
  /** Source handle (FSA path), or null on the input fallback. */
  handle: FileSystemFileHandle | null
  file: File
}

export interface OpenPickOptions {
  /** Accepted MIME → extensions map, e.g. `{ 'application/json': ['.grade'] }`. */
  accept: Record<string, string[]>
  description?: string
}

/** True when the browser can show a native open dialog. */
export function supportsNativeOpen(): boolean {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function'
}

/**
 * Ask the user to pick a file to open. Returns the file (plus a handle when the
 * native picker is available, so callers can save back in place), or `null` if
 * the user cancels. Must be called within a user gesture.
 */
export async function pickOpenFile(opts: OpenPickOptions): Promise<OpenTarget | null> {
  if (supportsNativeOpen()) {
    try {
      const [handle] = await window.showOpenFilePicker!({
        types: [{ description: opts.description ?? 'File', accept: opts.accept }],
        multiple: false,
      })
      if (!handle) return null
      return { handle, file: await handle.getFile() }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null
      // Otherwise fall through to the input fallback.
    }
  }
  return pickViaInput(opts, false)
}

/**
 * Like `pickOpenFile`, but allows selecting several files at once. Returns one
 * target per chosen file (with handles when the native picker is available), or
 * an empty array if the user cancels. Must be called within a user gesture.
 */
export async function pickOpenFiles(opts: OpenPickOptions): Promise<OpenTarget[]> {
  if (supportsNativeOpen()) {
    try {
      const handles = await window.showOpenFilePicker!({
        types: [{ description: opts.description ?? 'File', accept: opts.accept }],
        multiple: true,
      })
      return Promise.all(handles.map(async (handle) => ({ handle, file: await handle.getFile() })))
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return []
      // Otherwise fall through to the input fallback.
    }
  }
  return pickViaInput(opts, true)
}

/** Fallback open path for browsers without the File System Access API. */
function pickViaInput(opts: OpenPickOptions, multiple: false): Promise<OpenTarget | null>
function pickViaInput(opts: OpenPickOptions, multiple: true): Promise<OpenTarget[]>
function pickViaInput(
  opts: OpenPickOptions,
  multiple = false,
): Promise<OpenTarget | null | OpenTarget[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = multiple
    // Build an accept string from both extensions and MIME types.
    input.accept = [...Object.values(opts.accept).flat(), ...Object.keys(opts.accept)].join(',')
    input.style.display = 'none'
    document.body.appendChild(input)
    input.addEventListener(
      'change',
      () => {
        const files = Array.from(input.files ?? [])
        input.remove()
        if (multiple) {
          resolve(files.map((file) => ({ handle: null, file })))
        } else {
          resolve(files[0] ? { handle: null, file: files[0] } : null)
        }
      },
      { once: true },
    )
    input.click()
  })
}

/** Fallback path: trigger a browser download via a temporary anchor. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke after the click has had a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
