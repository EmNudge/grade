import type { GraphNode, NodeDef, ParamDef } from './types'

/**
 * The node registry. Core registers the built-ins; plugins call `register()`
 * with their own `NodeDef`s. This is the single extension seam of the engine.
 */
export class NodeRegistry {
  private defs = new Map<string, NodeDef>()

  register(def: NodeDef): this {
    if (this.defs.has(def.type)) {
      throw new Error(`Node type already registered: ${def.type}`)
    }
    this.defs.set(def.type, def)
    return this
  }

  get(type: string): NodeDef | undefined {
    return this.defs.get(type)
  }

  require(type: string): NodeDef {
    const def = this.defs.get(type)
    if (!def) throw new Error(`Unknown node type: ${type}`)
    return def
  }

  list(): NodeDef[] {
    return [...this.defs.values()]
  }
}

/** Resolve a default value for a single param. */
export function paramDefault(p: ParamDef): number | string | boolean {
  return p.default
}

/** Build a fully-defaulted values map for a node type. */
export function defaultValues(def: NodeDef): Record<string, number | string | boolean> {
  const values: Record<string, number | string | boolean> = {}
  for (const p of def.params) values[p.key] = paramDefault(p)
  return values
}

/** Construct a GraphNode instance with defaults applied. */
export function makeNode(def: NodeDef, id: string): GraphNode {
  return { id, type: def.type, values: defaultValues(def) }
}
