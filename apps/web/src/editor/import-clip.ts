// Importing footage into the media pool — shared by the viewer's drop zone and
// the media pool's "Import" button so both add a clip the same way.

import { generateClipThumbnail } from './clip-thumbnail'
import { putClipHandle } from './clip-handles'
import { pickOpenFiles } from './save-file'
import { useEditor } from './store'

/** Concrete MIME types so the native open dialog accepts common video files. */
export const CLIP_ACCEPT = {
  description: 'Video clip',
  accept: {
    'video/mp4': ['.mp4', '.m4v'],
    'video/quicktime': ['.mov'],
    'video/webm': ['.webm'],
    'video/x-matroska': ['.mkv'],
  },
}

/** Open the file picker (multi-select) and add the chosen clips to the pool. */
export async function pickAndAddClip(): Promise<void> {
  const picked = await pickOpenFiles(CLIP_ACCEPT)
  for (const target of picked) {
    if (!target.file.type.startsWith('video/')) continue
    const id = useEditor.getState().addClip(target.file)
    attachThumbnail(id, target.file)
    // Remember the handle so a project can re-open this footage in a later session.
    if (target.handle) void putClipHandle(target.file.name, target.handle)
  }
}

/**
 * Add one or more dropped/selected video files to the pool, each with a bin
 * thumbnail grabbed in the background. Non-video files are ignored. Shared by
 * the picker and the viewer's drop zone so both behave the same.
 */
export function addClipFiles(files: File[]): void {
  for (const file of files) {
    if (!file.type.startsWith('video/')) continue
    const id = useEditor.getState().addClip(file)
    attachThumbnail(id, file)
  }
}

/** Decode a bin thumbnail off-screen and stash it on the clip once ready. */
function attachThumbnail(id: string, file: File): void {
  void generateClipThumbnail(file).then((url) =>
    url ? useEditor.getState().setClipThumbnail(id, url) : undefined,
  )
}
