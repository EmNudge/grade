// `.grade` project files: the node graph plus the clip it was graded against.
//
// The graph reuses the template snapshot (structure + param values, no node
// positions or LUT pixel data), so loading a project rebuilds the graph the same
// way applying a template does. The clip itself isn't embedded — only its name
// and frame rate are stored, and the user re-opens the footage by hand.

import type { GraphTemplate } from './templates'

/** On-disk schema version. Bump when the shape changes incompatibly. */
export const PROJECT_VERSION = 1
const MAGIC = 'grade-project'

export interface NodePosition {
  x: number
  y: number
}

export interface GradeProject {
  format: typeof MAGIC
  version: number
  graph: GraphTemplate
  /** Node placements aligned to `graph.nodes`, so layout survives a round-trip. */
  positions?: NodePosition[]
  /** Filename of the source clip — a reference for the user, not embedded media. */
  clipName?: string
  clipFps?: number
}

export interface ClipRef {
  name: string | null
  fps: number | null
}

export function buildProject(
  graph: GraphTemplate,
  positions: NodePosition[],
  clip: ClipRef,
): GradeProject {
  return {
    format: MAGIC,
    version: PROJECT_VERSION,
    graph,
    positions,
    ...(clip.name ? { clipName: clip.name } : {}),
    ...(clip.fps != null ? { clipFps: clip.fps } : {}),
  }
}

export function serializeProject(project: GradeProject): string {
  return JSON.stringify(project, null, 2)
}

/** Parse + validate a `.grade` file, throwing a user-facing message on bad input. */
export function parseProject(text: string): GradeProject {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Not a valid project file (invalid JSON).')
  }
  if (!isRecord(data) || data['format'] !== MAGIC) {
    throw new Error('This file isn’t a Grade project.')
  }
  const version = data['version']
  if (typeof version !== 'number' || version > PROJECT_VERSION) {
    throw new Error(`This project needs a newer version of Grade (file v${String(version)}).`)
  }
  const graph = data['graph']
  if (!isRecord(graph) || !Array.isArray(graph['nodes']) || !Array.isArray(graph['edges'])) {
    throw new Error('Project file is missing its node graph.')
  }
  return data as unknown as GradeProject
}

/** Suggested filename for a project given the loaded clip name. */
export function projectFilename(clipName: string | null): string {
  const base = (clipName ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
  return `${base || 'untitled'}.grade`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
