// Graph templates — a saved node graph *structure* (node types, FX stacks, and
// their param values) with positions and loaded LUTs stripped, so a look can be
// re-applied to future footage. Persisted in localStorage.

export interface TemplateFx {
  type: string
  values: Record<string, number | string | boolean>
  base?: boolean
}

export interface TemplateNode {
  role: 'input' | 'output' | 'effect'
  ioType?: string
  fx: TemplateFx[]
  enabled: boolean
  label?: string
  accent?: string
}

/** A position-less graph: nodes plus edges referencing nodes by array index. */
export interface GraphTemplate {
  nodes: TemplateNode[]
  edges: [number, number][]
}

export interface SavedTemplate {
  id: string
  name: string
  template: GraphTemplate
  createdAt: number
}

const KEY = 'grade:templates'

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `tpl-${Date.now()}-${Math.round(Math.random() * 1e6)}`
}

/** All saved templates, newest first. Returns [] if storage is empty/unavailable. */
export function listTemplates(): SavedTemplate[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as SavedTemplate[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function write(list: SavedTemplate[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* quota / privacy mode — saving is best-effort */
  }
}

/** Save a new template under `name`, returning the stored record. */
export function saveTemplate(name: string, template: GraphTemplate): SavedTemplate {
  const record: SavedTemplate = { id: newId(), name, template, createdAt: Date.now() }
  write([record, ...listTemplates()])
  return record
}

export function deleteTemplate(id: string): void {
  write(listTemplates().filter((t) => t.id !== id))
}
