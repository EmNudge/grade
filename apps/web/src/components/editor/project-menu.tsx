import { useCallback, useState } from 'react'
import { FileDown, FolderOpen, FolderUp, Save, X } from 'lucide-react'
import {
  type RecentProject,
  forgetRecentProject,
  listRecentProjects,
} from '../../editor/recent-projects'
import { useProjectActions } from '../../editor/use-project-actions'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '../ui/dropdown-menu'

/**
 * Project submenu (lives under the Grade menu) — open/save `.grade` files plus a
 * list of recently used projects for one-click reopening. The actual logic lives
 * in `useProjectActions` so the editor shell can share it for restore-on-load.
 */
export function ProjectMenu() {
  const { open, save, saveAs, openRecent } = useProjectActions()
  const [recents, setRecents] = useState<RecentProject[]>([])

  const refreshRecents = useCallback(() => void listRecentProjects().then(setRecents), [])

  const onForget = (e: React.MouseEvent, rp: RecentProject) => {
    e.stopPropagation()
    void forgetRecentProject(rp.name).then(refreshRecents)
  }

  return (
    <DropdownMenuSub onOpenChange={(isOpen) => isOpen && refreshRecents()}>
      <DropdownMenuSubTrigger>
        <FolderOpen className="mr-2 size-3.5" /> Project
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-52">
        <DropdownMenuItem onClick={() => void open()}>
          <FolderUp className="mr-2 size-3.5" /> Open project…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void save()}>
          <Save className="mr-2 size-3.5" /> Save project
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void saveAs()}>
          <FileDown className="mr-2 size-3.5" /> Save project as…
        </DropdownMenuItem>
        {recents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Recent</DropdownMenuLabel>
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
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
