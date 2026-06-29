import {
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
} from '@xyflow/react'
import type { Engine } from '@grade/engine'
import type { Graph, NodeRole } from '@grade/nodes'
import { defaultValues } from '@grade/nodes'
import { create } from 'zustand'
import { registry } from './registry'
import type { GraphTemplate, TemplateFx, TemplateNode } from './templates'

export type NodeValues = Record<string, number | string | boolean>

/** A captured reference still — a graded frame snapshot for the stills gallery. */
export interface Still {
  id: string
  /** JPEG/PNG data URL of the graded frame. */
  url: string
  /** Source video time (seconds) the still was grabbed at. */
  time: number
  label: string
}

/**
 * A clip in the media pool. Each clip carries its **own** node graph, so
 * switching clips swaps both the footage and its grade. The `file` is the
 * runtime source reloaded into the viewer on activation; `graph`/`positions`
 * are the saved structure (mirrors a project's stored graph).
 */
export interface Clip {
  id: string
  name: string
  fps: number | null
  /** Runtime source file, reloaded into the <video> when this clip is activated. */
  file: File | null
  /** Ungraded first-frame thumbnail for the bin (data URL), filled in lazily. */
  thumbnail?: string
  /** This clip's node graph — structure + values, no positions. */
  graph: GraphTemplate
  /** Node positions aligned to `graph.nodes`. */
  positions: { x: number; y: number }[]
}

/** A loaded 3D LUT attached to a `lut` FX (out-of-band — not a scalar param). */
export interface LoadedLut {
  /** Display name (the file name, sans extension, or the LUT's TITLE). */
  name: string
  size: number
  data: Float32Array
}

/** One effect in a node's FX stack. `base` marks the non-removable corrector. */
export interface FxInstance {
  id: string
  type: string
  values: NodeValues
  base?: boolean
  /** For `lut` FX: the loaded lookup table, pushed to the engine out-of-band. */
  lut?: LoadedLut
}

export interface GradeNodeData {
  role: NodeRole // 'input' | 'output' | 'effect'
  ioType?: string // def type for I/O nodes ('input' | 'output')
  fx: FxInstance[] // FX stack for effect nodes (base corrector + extras)
  enabled: boolean
  label?: string // user-set node name (defaults to "Corrector")
  accent?: string // user-set node colour (defaults to the corrector accent)
  [key: string]: unknown
}

export type GradeNode = Node<GradeNodeData>

/** The base corrector that every effect node carries. */
export const BASE_FX_TYPE = 'color-correct'

let nodeCounter = 0
let edgeCounter = 0
let fxCounter = 0
let clipCounter = 0
const nextId = (prefix: string) => `${prefix}-${++nodeCounter}`
const edgeId = () => `e${++edgeCounter}`
const fxId = () => `fx${++fxCounter}`
const clipId = () => `clip-${++clipCounter}`

/** Seconds → m:ss.ss, for a still's capture-time label. */
function formatTime(t: number): string {
  const m = Math.floor(t / 60)
  const s = (t % 60).toFixed(2).padStart(5, '0')
  return `${m}:${s}`
}

/** Grab the engine's current graded frame as a JPEG data URL (capped width). */
async function grabStill(engine: Engine): Promise<string | null> {
  const dims = engine.dimensions
  if (!dims.width) return null
  const w = Math.min(480, dims.width)
  const h = Math.max(1, Math.round((dims.height / dims.width) * w))
  const frame = await engine.sampleScopes(w, h)
  if (!frame) return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const out = ctx.createImageData(w, h)
  const bgra = frame.format === 'BGRA'
  const d = frame.data
  for (let i = 0; i < w * h * 4; i += 4) {
    out.data[i] = d[bgra ? i + 2 : i] ?? 0
    out.data[i + 1] = d[i + 1] ?? 0
    out.data[i + 2] = d[bgra ? i : i + 2] ?? 0
    out.data[i + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
  return canvas.toDataURL('image/jpeg', 0.85)
}

/** Most undo steps the history keeps before dropping the oldest. */
const HISTORY_LIMIT = 100
/** Same-keyed edits within this window collapse into a single undo step. */
const COALESCE_MS = 500

/** The undoable slice of the editor — the document, minus transient runtime state. */
interface Snapshot {
  nodes: GradeNode[]
  edges: Edge[]
  selectedId: string | null
  activeFxId: string | null
}

function makeFx(type: string, base = false): FxInstance {
  return { id: fxId(), type, values: defaultValues(registry.require(type)), base }
}

function createEffectNode(position: { x: number; y: number }, fx?: FxInstance[]): GradeNode {
  return {
    id: nextId('node'),
    type: 'grade',
    position,
    deletable: true,
    data: { role: 'effect', fx: fx ?? [makeFx(BASE_FX_TYPE, true)], enabled: true },
  }
}

function createIONode(ioType: 'input' | 'output', position: { x: number; y: number }): GradeNode {
  return {
    id: nextId(ioType),
    type: 'grade',
    position,
    deletable: false,
    data: { role: ioType, ioType, fx: [], enabled: true },
  }
}

function connect(source: string, target: string): Edge {
  return { id: edgeId(), source, target }
}

function midpoint(a: GradeNode, b: GradeNode) {
  return { x: (a.position.x + b.position.x) / 2, y: (a.position.y + b.position.y) / 2 }
}

/** Media In -> [Color Space + Lift/Gamma/Gain corrector] -> Viewer. */
function starterGraph(): { nodes: GradeNode[]; edges: Edge[]; selectedId: string } {
  const input = createIONode('input', { x: 0, y: 120 })
  const corrector = createEffectNode({ x: 320, y: 80 }, [
    makeFx('color-space'),
    makeFx(BASE_FX_TYPE, true),
  ])
  const output = createIONode('output', { x: 680, y: 120 })
  return {
    nodes: [input, corrector, output],
    edges: [connect(input.id, corrector.id), connect(corrector.id, output.id)],
    selectedId: corrector.id,
  }
}

function firstEffectId(nodes: GradeNode[]): string | null {
  return nodes.find((n) => n.data.role === 'effect')?.id ?? null
}

/** Snapshot one FX instance for a template (drops the runtime id + loaded LUT). */
function toTemplateFx(f: FxInstance): TemplateFx {
  const tf: TemplateFx = { type: f.type, values: { ...f.values } }
  if (f.base) tf.base = true
  return tf
}

/** Snapshot one node's structure for a template (drops id + position). */
function toTemplateNode(n: GradeNode): TemplateNode {
  const tn: TemplateNode = {
    role: n.data.role,
    fx: n.data.fx.map(toTemplateFx),
    enabled: n.data.enabled,
  }
  if (n.data.ioType) tn.ioType = n.data.ioType
  if (n.data.label) tn.label = n.data.label
  if (n.data.accent) tn.accent = n.data.accent
  return tn
}

/** Snapshot a live graph into a position-less template + aligned positions. */
function templateOf(
  nodes: GradeNode[],
  edges: Edge[],
): {
  graph: GraphTemplate
  positions: { x: number; y: number }[]
} {
  const index = new Map(nodes.map((n, i) => [n.id, i]))
  return {
    graph: {
      nodes: nodes.map(toTemplateNode),
      edges: edges.flatMap((e) => {
        const a = index.get(e.source)
        const b = index.get(e.target)
        return a === undefined || b === undefined ? [] : [[a, b] as [number, number]]
      }),
    },
    positions: nodes.map((n) => ({ x: n.position.x, y: n.position.y })),
  }
}

interface EditorState {
  nodes: GradeNode[]
  edges: Edge[]
  selectedId: string | null
  commandOpen: boolean
  video: HTMLVideoElement | null
  canvas: HTMLCanvasElement | null
  engine: Engine | null
  clipName: string | null
  clipFps: number | null
  /** A clip the Viewer should load on its next render (e.g. a project's footage
   *  re-opened from a saved file handle). Cleared once the Viewer consumes it. */
  pendingClip: File | null

  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onConnect: (conn: Connection) => void
  addNode: () => void
  addSerialAfter: () => void
  addSerialBefore: () => void
  deleteNode: (id: string) => void
  deleteSelected: () => void
  resetNode: (id: string) => void
  toggleNodeEnabled: (id: string) => void
  setNodeLabel: (id: string, label: string) => void
  setNodeAccent: (id: string, accent: string) => void
  /** Add a free corrector node at a graph position (right-click on the pane). */
  addCorrectorAt: (pos: { x: number; y: number }) => void
  selectNode: (id: string | null) => void
  // FX-stack editing
  activeFxId: string | null
  setActiveFx: (fxId: string) => void
  updateFxValues: (nodeId: string, fxId: string, patch: NodeValues) => void
  setFxLut: (nodeId: string, fxId: string, lut: LoadedLut | null) => void
  addFx: (nodeId: string, type: string) => void
  removeFx: (nodeId: string, fxId: string) => void
  setCommandOpen: (open: boolean) => void
  setVideo: (video: HTMLVideoElement | null) => void
  setCanvas: (canvas: HTMLCanvasElement | null) => void
  setEngine: (engine: Engine | null) => void
  setClipName: (name: string | null) => void
  setClipFps: (fps: number | null) => void
  /** Request that the Viewer load this clip (or null to clear a consumed request). */
  setPendingClip: (file: File | null) => void
  togglePlay: () => void

  // Undo / redo over the document (nodes, edges, selection).
  past: Snapshot[]
  future: Snapshot[]
  undo: () => void
  redo: () => void

  // Reusable graph templates (structure only, no positions).
  getTemplate: () => GraphTemplate
  /** Rebuild the graph from a template. Pass `positions` (aligned to
   *  `t.nodes`) to restore exact placement instead of the synthetic row. */
  applyTemplate: (t: GraphTemplate, positions?: { x: number; y: number }[]) => void

  // Captured reference stills (session-scoped) + the one hovered for preview.
  stills: Still[]
  hoveredStillId: string | null
  addStill: (still: Omit<Still, 'id'>) => void
  removeStill: (id: string) => void
  setHoveredStill: (id: string | null) => void
  /** Grab the engine's current graded frame into the stills bin. Returns false
   *  when there's nothing to capture (no engine/frame yet). */
  captureStill: () => Promise<boolean>

  // Media pool: clips, each with its own node graph. The active clip's graph is
  // the live document (nodes/edges); switching swaps both footage and grade.
  clips: Clip[]
  activeClipId: string | null
  /** Add an imported clip to the pool and make it active (loads its footage). */
  addClip: (file: File) => void
  /** Switch to a clip — saves the current graph, restores the target's. */
  selectClip: (id: string) => void
  removeClip: (id: string) => void
  setClipThumbnail: (id: string, thumbnail: string) => void

  toGraph: () => Graph
  structureKey: () => string
}

export const useEditor = create<EditorState>((set, get) => {
  const initial = starterGraph()

  const mapNode = (id: string, fn: (n: GradeNode) => GradeNode) =>
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? fn(n) : n)) }))

  const snapshot = (s: EditorState): Snapshot => ({
    nodes: s.nodes,
    edges: s.edges,
    selectedId: s.selectedId,
    activeFxId: s.activeFxId,
  })

  let coalesceKey: string | null = null
  let coalesceAt = 0

  /**
   * Record the current document onto the undo stack *before* the calling
   * mutation changes it (state is immutable, so we keep references, not clones).
   * Pass a `key` to fold a burst of like edits — a slider/wheel drag, label
   * typing, a node drag — into one undo step; omit it for one-shot actions.
   */
  const commit = (key?: string) => {
    const now = performance.now()
    const coalesce = key != null && key === coalesceKey && now - coalesceAt < COALESCE_MS
    coalesceKey = key ?? null
    coalesceAt = now
    if (coalesce) return
    set((s) => ({ past: [...s.past, snapshot(s)].slice(-HISTORY_LIMIT), future: [] }))
  }

  return {
    nodes: initial.nodes,
    edges: initial.edges,
    selectedId: initial.selectedId,
    activeFxId: null,
    commandOpen: false,
    video: null,
    canvas: null,
    engine: null,
    clipName: null,
    clipFps: null,
    pendingClip: null,
    past: [],
    future: [],
    stills: [],
    hoveredStillId: null,
    clips: [],
    activeClipId: null,

    // Drags and removals are undoable (one step per drag); pure selection and
    // dimension-measurement changes from React Flow are not.
    onNodesChange: (changes) => {
      if (changes.some((c) => c.type === 'position' || c.type === 'remove'))
        commit(changes.every((c) => c.type === 'position') ? 'node-drag' : undefined)
      set((s) => ({ nodes: applyNodeChanges(changes, s.nodes) as GradeNode[] }))
    },
    onEdgesChange: (changes) => {
      if (changes.some((c) => c.type === 'remove')) commit()
      set((s) => ({ edges: applyEdgeChanges(changes, s.edges) }))
    },
    onConnect: (conn) => {
      commit()
      set((s) => ({ edges: addEdge({ ...conn, id: edgeId() }, s.edges) }))
    },

    addNode: () => {
      commit()
      set((s) => {
        const node = createEffectNode({ x: 320, y: 280 + s.nodes.length * 8 })
        return { nodes: [...s.nodes, node], selectedId: node.id }
      })
    },

    addSerialAfter: () => {
      commit()
      set((s) => {
        const byId = new Map(s.nodes.map((n) => [n.id, n]))
        let anchorId = s.selectedId
        if (!anchorId) {
          const output = s.nodes.find((n) => n.data.role === 'output')
          anchorId = output
            ? (s.edges.find((e) => e.target === output.id)?.source ??
              s.nodes.find((n) => n.data.role === 'input')?.id ??
              null)
            : null
        }
        const anchor = anchorId ? byId.get(anchorId) : undefined
        if (!anchor) return {}
        if (anchor.data.role === 'output') return insertBefore(s, anchor)
        return insertAfter(s, anchor)
      })
    },

    addSerialBefore: () => {
      commit()
      set((s) => {
        const byId = new Map(s.nodes.map((n) => [n.id, n]))
        let anchorId = s.selectedId
        if (!anchorId) anchorId = s.nodes.find((n) => n.data.role === 'output')?.id ?? null
        const anchor = anchorId ? byId.get(anchorId) : undefined
        if (!anchor) return {}
        if (anchor.data.role === 'input') return insertAfter(s, anchor)
        return insertBefore(s, anchor)
      })
    },

    deleteNode: (id) => {
      const target = get().nodes.find((n) => n.id === id)
      if (!target || target.deletable === false) return
      commit()
      set((s) => {
        const node = s.nodes.find((n) => n.id === id)
        if (!node || node.deletable === false) return {}
        const incoming = s.edges.filter((e) => e.target === id)
        const outgoing = s.edges.filter((e) => e.source === id)
        const rest = s.edges.filter((e) => e.source !== id && e.target !== id)
        const bridged: Edge[] = []
        for (const i of incoming)
          for (const o of outgoing) bridged.push(connect(i.source, o.target))
        const remaining = s.nodes.filter((n) => n.id !== id)
        return {
          nodes: remaining,
          edges: [...rest, ...bridged],
          selectedId: s.selectedId === id ? firstEffectId(remaining) : s.selectedId,
        }
      })
    },

    deleteSelected: () => {
      const { selectedId, deleteNode } = get()
      if (selectedId) deleteNode(selectedId)
    },

    resetNode: (id) => {
      commit()
      mapNode(id, (n) => ({
        ...n,
        data: {
          ...n.data,
          fx: n.data.fx.map((f) => ({ ...f, values: defaultValues(registry.require(f.type)) })),
        },
      }))
    },

    toggleNodeEnabled: (id) => {
      commit()
      mapNode(id, (n) =>
        n.data.role === 'effect' ? { ...n, data: { ...n.data, enabled: !n.data.enabled } } : n,
      )
    },

    setNodeLabel: (id, label) => {
      commit(`label:${id}`)
      mapNode(id, (n) => ({ ...n, data: { ...n.data, label } }))
    },

    setNodeAccent: (id, accent) => {
      commit()
      mapNode(id, (n) => ({ ...n, data: { ...n.data, accent } }))
    },

    addCorrectorAt: (pos) => {
      commit()
      set((s) => {
        const node = createEffectNode(pos)
        return { nodes: [...s.nodes, node], selectedId: node.id }
      })
    },

    selectNode: (id) => set({ selectedId: id }),

    updateFxValues: (nodeId, fid, patch) => {
      // Coalesce a continuous drag (slider, wheel, curve) into one undo step.
      commit(`fx:${nodeId}:${fid}`)
      mapNode(nodeId, (n) => ({
        ...n,
        data: {
          ...n.data,
          fx: n.data.fx.map((f) =>
            f.id === fid ? { ...f, values: { ...f.values, ...patch } } : f,
          ),
        },
      }))
    },

    setFxLut: (nodeId, fid, lut) => {
      commit()
      mapNode(nodeId, (n) => ({
        ...n,
        data: {
          ...n.data,
          fx: n.data.fx.map((f) => {
            if (f.id !== fid) return f
            if (!lut) {
              const { lut: _removed, ...rest } = f
              return rest
            }
            return { ...f, lut }
          }),
        },
      }))
    },

    setActiveFx: (id) => set({ activeFxId: id }),

    addFx: (nodeId, type) => {
      commit()
      set((s) => {
        const fx = makeFx(type)
        return {
          nodes: s.nodes.map((n) =>
            n.id === nodeId ? { ...n, data: { ...n.data, fx: [...n.data.fx, fx] } } : n,
          ),
          activeFxId: fx.id, // jump to the freshly added FX tab
        }
      })
    },

    removeFx: (nodeId, fid) => {
      commit()
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, fx: n.data.fx.filter((f) => f.id !== fid || f.base) } }
            : n,
        ),
        activeFxId: s.activeFxId === fid ? null : s.activeFxId,
      }))
    },

    setCommandOpen: (open) => set({ commandOpen: open }),
    setVideo: (video) => set({ video }),
    setCanvas: (canvas) => set({ canvas }),
    setEngine: (engine) => set({ engine }),
    setClipName: (clipName) => set({ clipName }),
    setPendingClip: (pendingClip) => set({ pendingClip }),
    setClipFps: (clipFps) =>
      set((s) => ({
        clipFps,
        clips: s.activeClipId
          ? s.clips.map((c) => (c.id === s.activeClipId ? { ...c, fps: clipFps } : c))
          : s.clips,
      })),

    togglePlay: () => {
      const v = get().video
      if (!v) return
      if (v.paused) void v.play().catch(() => {})
      else v.pause()
    },

    undo: () =>
      set((s) => {
        const prev = s.past[s.past.length - 1]
        if (!prev) return {}
        coalesceKey = null // the next edit starts a fresh undo group
        return {
          past: s.past.slice(0, -1),
          future: [snapshot(s), ...s.future].slice(0, HISTORY_LIMIT),
          nodes: prev.nodes,
          edges: prev.edges,
          selectedId: prev.selectedId,
          activeFxId: prev.activeFxId,
        }
      }),

    redo: () =>
      set((s) => {
        const next = s.future[0]
        if (!next) return {}
        coalesceKey = null
        return {
          future: s.future.slice(1),
          past: [...s.past, snapshot(s)].slice(-HISTORY_LIMIT),
          nodes: next.nodes,
          edges: next.edges,
          selectedId: next.selectedId,
          activeFxId: next.activeFxId,
        }
      }),

    // Capture the current document as a position-less, LUT-less template.
    getTemplate: () => {
      const { nodes, edges } = get()
      return templateOf(nodes, edges).graph
    },

    // Rebuild the graph from a template — fresh ids. Without `positions` the
    // nodes are auto-laid-out in a row; with them (a project load) each node
    // keeps its saved placement.
    applyTemplate: (t, positions) => {
      commit()
      set(() => {
        const ids: string[] = []
        const nodes: GradeNode[] = t.nodes.map((tn, i) => {
          const id = tn.role === 'effect' ? nextId('node') : nextId(tn.ioType ?? tn.role)
          ids[i] = id
          const fx: FxInstance[] = tn.fx.map((f) => ({
            id: fxId(),
            type: f.type,
            values: { ...f.values },
            ...(f.base ? { base: true } : {}),
          }))
          return {
            id,
            type: 'grade',
            position: positions?.[i] ?? { x: i * 240, y: 120 },
            deletable: tn.role === 'effect',
            data: {
              role: tn.role,
              ...(tn.ioType ? { ioType: tn.ioType } : {}),
              fx,
              enabled: tn.enabled,
              ...(tn.label ? { label: tn.label } : {}),
              ...(tn.accent ? { accent: tn.accent } : {}),
            },
          }
        })
        const edges: Edge[] = t.edges.flatMap(([a, b]) => {
          const from = ids[a]
          const to = ids[b]
          return from && to ? [connect(from, to)] : []
        })
        const selectedId = nodes.find((n) => n.data.role === 'effect')?.id ?? null
        return { nodes, edges, selectedId, activeFxId: null }
      })
    },

    addStill: (still) =>
      set((s) => ({ stills: [{ ...still, id: `still-${++fxCounter}` }, ...s.stills] })),
    removeStill: (id) =>
      set((s) => ({
        stills: s.stills.filter((x) => x.id !== id),
        hoveredStillId: s.hoveredStillId === id ? null : s.hoveredStillId,
      })),
    setHoveredStill: (id) => set({ hoveredStillId: id }),

    captureStill: async () => {
      const { engine, video, addStill } = get()
      if (!engine) return false
      const url = await grabStill(engine)
      if (!url) return false
      const time = video?.currentTime ?? 0
      addStill({ url, time, label: formatTime(time) })
      return true
    },

    // Save the live graph into the active clip before adding/switching, so each
    // clip keeps its own grade. The first clip adopts the current starter graph;
    // later clips begin from a fresh starter.
    addClip: (file) => {
      set((s) => {
        const snapped = s.activeClipId
          ? s.clips.map((c) =>
              c.id === s.activeClipId ? { ...c, ...templateOf(s.nodes, s.edges) } : c,
            )
          : s.clips
        const isFirst = s.clips.length === 0
        const seed = isFirst ? templateOf(s.nodes, s.edges) : null
        const fresh = isFirst ? null : starterGraph()
        const id = clipId()
        const clip: Clip = {
          id,
          name: file.name,
          fps: null,
          file,
          graph: seed ? seed.graph : templateOf(fresh!.nodes, fresh!.edges).graph,
          positions: seed ? seed.positions : templateOf(fresh!.nodes, fresh!.edges).positions,
        }
        const base = { clips: [...snapped, clip], activeClipId: id }
        return fresh
          ? {
              ...base,
              nodes: fresh.nodes,
              edges: fresh.edges,
              selectedId: fresh.selectedId,
              activeFxId: null,
            }
          : base
      })
      get().setPendingClip(file)
    },

    selectClip: (id) => {
      const s = get()
      if (id === s.activeClipId) return
      const target = s.clips.find((c) => c.id === id)
      if (!target) return
      set((st) => ({
        clips: st.activeClipId
          ? st.clips.map((c) =>
              c.id === st.activeClipId ? { ...c, ...templateOf(st.nodes, st.edges) } : c,
            )
          : st.clips,
        activeClipId: id,
      }))
      get().applyTemplate(target.graph, target.positions)
      get().setClipName(target.name)
      get().setClipFps(target.fps)
      if (target.file) get().setPendingClip(target.file)
    },

    removeClip: (id) => {
      const s = get()
      const remaining = s.clips.filter((c) => c.id !== id)
      if (s.activeClipId !== id) {
        set({ clips: remaining })
        return
      }
      const next = remaining[0]
      set({ clips: remaining, activeClipId: next ? next.id : null })
      if (next) {
        get().applyTemplate(next.graph, next.positions)
        get().setClipName(next.name)
        get().setClipFps(next.fps)
        if (next.file) get().setPendingClip(next.file)
      } else {
        // Pool emptied — keep the last frame on screen but reset name/fps.
        get().setClipName(null)
        get().setClipFps(null)
      }
    },

    setClipThumbnail: (id, thumbnail) =>
      set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, thumbnail } : c)) })),

    toGraph: () => {
      const { nodes, edges } = get()
      const fxKey = (nodeId: string, f: FxInstance) => `${nodeId}:${f.id}`
      const engineNodes: Graph['nodes'] = []
      const engineEdges: Graph['edges'] = []

      for (const n of nodes) {
        if (n.data.role !== 'effect') {
          engineNodes.push({ id: n.id, type: n.data.ioType ?? n.data.role, values: {} })
          continue
        }
        // Chain the FX within the node.
        let prev: string | null = null
        for (const f of n.data.fx) {
          const key = fxKey(n.id, f)
          engineNodes.push({ id: key, type: f.type, values: f.values, enabled: n.data.enabled })
          if (prev) engineEdges.push({ from: prev, to: key })
          prev = key
        }
      }

      const entry = (nodeId: string) => {
        const n = nodes.find((x) => x.id === nodeId)
        return n && n.data.role === 'effect' && n.data.fx[0] ? fxKey(nodeId, n.data.fx[0]) : nodeId
      }
      const exit = (nodeId: string) => {
        const n = nodes.find((x) => x.id === nodeId)
        const last = n?.data.fx[n.data.fx.length - 1]
        return n && n.data.role === 'effect' && last ? fxKey(nodeId, last) : nodeId
      }
      for (const e of edges) engineEdges.push({ from: exit(e.source), to: entry(e.target) })

      return { nodes: engineNodes, edges: engineEdges }
    },

    structureKey: () => {
      const { nodes, edges } = get()
      const n = nodes
        .map(
          (x) =>
            `${x.id}:${x.data.role}:${x.data.enabled}:${x.data.fx.map((f) => `${f.id}~${f.type}`).join('+')}`,
        )
        .join(',')
      const e = edges
        .map((x) => `${x.source}->${x.target}`)
        .toSorted()
        .join(',')
      return `${n}|${e}`
    },
  }
})

// ---- serial-insert helpers (pure; return a partial state patch) ----

function insertAfter(
  s: Pick<EditorState, 'nodes' | 'edges'>,
  anchor: GradeNode,
): Partial<EditorState> {
  const byId = new Map(s.nodes.map((n) => [n.id, n]))
  const downstream = s.edges.find((e) => e.source === anchor.id)
  const successor = downstream ? byId.get(downstream.target) : undefined
  const pos = successor
    ? midpoint(anchor, successor)
    : { x: anchor.position.x + 240, y: anchor.position.y }
  const node = createEffectNode(pos)
  const edges = s.edges.filter((e) => !(e.source === anchor.id && e.target === successor?.id))
  edges.push(connect(anchor.id, node.id))
  if (successor) edges.push(connect(node.id, successor.id))
  return { nodes: [...s.nodes, node], edges, selectedId: node.id }
}

function insertBefore(
  s: Pick<EditorState, 'nodes' | 'edges'>,
  anchor: GradeNode,
): Partial<EditorState> {
  const byId = new Map(s.nodes.map((n) => [n.id, n]))
  const upstream = s.edges.find((e) => e.target === anchor.id)
  const predecessor = upstream ? byId.get(upstream.source) : undefined
  const pos = predecessor
    ? midpoint(predecessor, anchor)
    : { x: anchor.position.x - 240, y: anchor.position.y }
  const node = createEffectNode(pos)
  const edges = s.edges.filter((e) => !(e.target === anchor.id && e.source === predecessor?.id))
  if (predecessor) edges.push(connect(predecessor.id, node.id))
  edges.push(connect(node.id, anchor.id))
  return { nodes: [...s.nodes, node], edges, selectedId: node.id }
}
