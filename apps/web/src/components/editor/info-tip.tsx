import { CircleHelp } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '#/components/ui/tooltip.tsx'
import { DESCRIPTIONS } from '#/components/editor/descriptions.ts'

/**
 * A small "?" icon that shows a tooltip with the description for a grading
 * surface when hovered. `key` must exist in `DESCRIPTIONS` in descriptions.ts.
 *
 * Use `asChild` to wrap the info icon into an existing label/button for inline
 * layout without adding a second focusable element.
 */
export function InfoTip({
  descKey,
  side = 'top',
  align = 'center',
  className,
}: {
  descKey: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  className?: string
}) {
  const text = DESCRIPTIONS[descKey]
  if (!text) {
    if (process.env['NODE_ENV'] !== 'production') {
      console.warn(`[InfoTip] No description for key "${descKey}"`)
    }
    return null
  }

  return (
    <Tooltip>
      <TooltipTrigger
        className={`inline-flex shrink-0 cursor-help items-center justify-center text-muted-foreground/50 transition-colors hover:text-muted-foreground ${className ?? ''}`}
        aria-label={`Learn about this tool: ${text.slice(0, 60)}\u2026`}
      >
        <CircleHelp className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent side={side} align={align} className="max-w-xs text-xs leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
