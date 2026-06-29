import { createDefaultRegistry } from '@grade/nodes'

// Single shared registry. Plugins would call registry.register(...) here.
export const registry = createDefaultRegistry()
