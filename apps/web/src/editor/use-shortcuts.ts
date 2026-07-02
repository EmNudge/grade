import { useEffect } from 'react'
import { useEditor } from './store'

// Input types that are NOT text entry — Space/Backspace shortcuts should still
// fire when one of these is focused. Notably <input type="range"> is what Base
// UI's slider thumb focuses, so the timeline must not count as "editable".
const NON_TEXT_INPUT_TYPES = new Set([
  'range',
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'file',
  'color',
  'image',
])

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !NON_TEXT_INPUT_TYPES.has((el as HTMLInputElement).type)
  return false
}

/**
 * Global editor keyboard shortcuts (DaVinci Resolve color-page muscle memory):
 *   ⌘/Ctrl+K  command palette
 *   ⌘/Ctrl+Z  undo  ·  ⌘⇧Z / Ctrl+Y  redo
 *   Alt+S     add serial node after the current node
 *   Shift+S   add serial node before the current node
 *   Delete/Backspace  delete the selected node
 */
export function useShortcuts() {
  const addSerialAfter = useEditor((s) => s.addSerialAfter)
  const addSerialBefore = useEditor((s) => s.addSerialBefore)
  const deleteSelected = useEditor((s) => s.deleteSelected)
  const setCommandOpen = useEditor((s) => s.setCommandOpen)
  const togglePlay = useEditor((s) => s.togglePlay)
  const toggleNodeEnabled = useEditor((s) => s.toggleNodeEnabled)
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K — toggle palette (works even while typing elsewhere).
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyK') {
        e.preventDefault()
        setCommandOpen(!useEditor.getState().commandOpen)
        return
      }

      // ⌘D / Ctrl+D — disable/enable the selected node.
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyD') {
        e.preventDefault()
        const id = useEditor.getState().selectedId
        if (id) toggleNodeEnabled(id)
        return
      }

      // Everything below is suppressed while typing or while the palette is open,
      // so text fields keep their native undo/redo and shortcuts.
      if (isEditable(e.target) || useEditor.getState().commandOpen) return

      // I — toggle info mode (hover to see surface descriptions).
      if (e.code === 'KeyI' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        useEditor.getState().setInfoMode(!useEditor.getState().infoMode)
        return
      }

      // Escape — exit info mode.
      if (e.code === 'Escape' && useEditor.getState().infoMode) {
        e.preventDefault()
        useEditor.getState().setInfoMode(false)
        return
      }

      // ⌘Z / Ctrl+Z — undo;  ⌘⇧Z / Ctrl+Y — redo.
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyY') {
        e.preventDefault()
        redo()
        return
      }

      // Space — play/pause the clip (only intercept when a clip is loaded).
      // stopPropagation so a focused widget (e.g. the timeline slider thumb)
      // can't also swallow or act on the key.
      if (e.code === 'Space' && useEditor.getState().video) {
        e.preventDefault()
        e.stopPropagation()
        togglePlay()
        return
      }

      if (e.code === 'KeyS' && e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        addSerialAfter()
        return
      }
      if (e.code === 'KeyS' && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        addSerialBefore()
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        deleteSelected()
      }
    }

    // Capture phase: the global shortcuts win before any focused widget (the
    // slider, buttons, the node canvas) can consume the key on bubble.
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [
    addSerialAfter,
    addSerialBefore,
    deleteSelected,
    setCommandOpen,
    togglePlay,
    toggleNodeEnabled,
    undo,
    redo,
  ])
}
