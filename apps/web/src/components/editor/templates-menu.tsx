import { useState } from 'react'
import { LayoutTemplate, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { useEditor } from '../../editor/store'
import {
  deleteTemplate,
  listTemplates,
  saveTemplate,
  type SavedTemplate,
} from '../../editor/templates'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'

/**
 * Save the current node graph as a reusable template (structure + param values,
 * no positions) and apply saved templates to the current footage.
 */
export function TemplatesMenu() {
  const getTemplate = useEditor((s) => s.getTemplate)
  const applyTemplate = useEditor((s) => s.applyTemplate)
  const [items, setItems] = useState<SavedTemplate[]>([])

  const refresh = () => setItems(listTemplates())

  const onSave = () => {
    const name = window.prompt('Template name')?.trim()
    if (!name) return
    saveTemplate(name, getTemplate())
    refresh()
    toast.success(`Saved template "${name}"`)
  }

  const onApply = (t: SavedTemplate) => {
    applyTemplate(t.template)
    toast.success(`Applied template "${t.name}"`, { description: 'Node positions auto-arranged.' })
  }

  const onDelete = (e: React.MouseEvent, t: SavedTemplate) => {
    e.stopPropagation()
    deleteTemplate(t.id)
    refresh()
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && refresh()}>
      <DropdownMenuTrigger
        render={<Button size="sm" variant="ghost" className="h-7 gap-1.5" />}
        title="Graph templates"
      >
        <LayoutTemplate className="size-4" /> Templates
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onSave}>
            <Plus className="mr-2 size-3.5" /> Save current graph…
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {items.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {items.map((t) => (
                <DropdownMenuItem
                  key={t.id}
                  onClick={() => onApply(t)}
                  className="group/item justify-between gap-2"
                >
                  <span className="truncate">{t.name}</span>
                  <button
                    type="button"
                    onClick={(e) => onDelete(e, t)}
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/item:opacity-100"
                    aria-label={`Delete template ${t.name}`}
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
