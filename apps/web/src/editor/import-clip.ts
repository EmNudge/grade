// Importing footage into the media pool — shared by the viewer's drop zone and
// the media pool's "Import" button so both add a clip the same way.

import { putClipHandle } from './clip-handles'
import { pickOpenFile } from './save-file'
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

/** Open the file picker and add the chosen clip to the pool. */
export async function pickAndAddClip(): Promise<void> {
  const picked = await pickOpenFile(CLIP_ACCEPT)
  if (!picked) return
  if (!picked.file.type.startsWith('video/')) return
  useEditor.getState().addClip(picked.file)
  // Remember the handle so a project can re-open this footage in a later session.
  if (picked.handle) void putClipHandle(picked.file.name, picked.handle)
}
