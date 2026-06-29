import { ArrowLeftToLine, ArrowRightToLine, Trash2 } from 'lucide-react'
import { useEditor } from '../../editor/store'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '../ui/command'

export function CommandPalette() {
  const open = useEditor((s) => s.commandOpen)
  const setOpen = useEditor((s) => s.setCommandOpen)
  const addSerialAfter = useEditor((s) => s.addSerialAfter)
  const addSerialBefore = useEditor((s) => s.addSerialBefore)
  const deleteSelected = useEditor((s) => s.deleteSelected)
  const selectedId = useEditor((s) => s.selectedId)

  const run = (fn: () => void) => {
    fn()
    setOpen(false)
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command palette">
      <Command>
        <CommandInput placeholder="Run a command…" />
        <CommandList>
          <CommandEmpty>No matches.</CommandEmpty>
          <CommandGroup heading="Nodes">
            <CommandItem value="add corrector after" onSelect={() => run(() => addSerialAfter())}>
              <ArrowRightToLine />
              Add corrector after
              <CommandShortcut>⌥S</CommandShortcut>
            </CommandItem>
            <CommandItem value="add corrector before" onSelect={() => run(() => addSerialBefore())}>
              <ArrowLeftToLine />
              Add corrector before
              <CommandShortcut>⇧S</CommandShortcut>
            </CommandItem>
            <CommandItem
              value="delete selected node"
              disabled={!selectedId}
              onSelect={() => run(deleteSelected)}
            >
              <Trash2 />
              Delete selected node
              <CommandShortcut>⌫</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
