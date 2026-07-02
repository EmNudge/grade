import type { ReactElement } from 'react'

import { DESCRIPTIONS } from '#/components/editor/descriptions.ts'
import { Tooltip, TooltipContent, TooltipTrigger } from '#/components/ui/tooltip.tsx'
import { useEditor } from '#/editor/store.ts'

/**
 * Wraps a labeled surface so that its description tooltip shows on hover when
 * info mode is active (toggled via the info-mode button or I key). When info
 * mode is off the children render with no tooltip wrapper at all.
 *
 * Children MUST be a single ReactElement (the trigger). Use `render` so the
 * trigger element itself is the interactive tooltip target — no extra wrapper.
 */
export function InfoDecorator({ descKey, children }: { descKey: string; children: ReactElement }) {
  const infoMode = useEditor((s) => s.infoMode)

  if (!infoMode) return children

  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="bottom" className="max-w-xs text-xs leading-relaxed">
        {DESCRIPTIONS[descKey]}
      </TooltipContent>
    </Tooltip>
  )
}
