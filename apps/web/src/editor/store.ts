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

export type NodeValues = Record<string, number | string | boolean>

/** One effect in a node's FX stack. `base` marks the non-removable corrector. */
export interface FxInstance {
  id: string
  type: string
  values: NodeValues
  base?: boolean
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
const nextId = (prefix: string) => `${prefix}-${++nodeCounter}`
const edgeId = () => `e${++edgeCounter}`
const fxId = () => `fx${++fxCounter}`

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
  addFx: (nodeId: string, type: string) => void
  removeFx: (nodeId: string, fxId: string) => void
  setCommandOpen: (open: boolean) => void
  setVideo: (video: HTMLVideoElement | null) => void
  setCanvas: (canvas: HTMLCanvasElement | null) => void
  setEngine: (engine: Engine | null) => void
  setClipName: (name: string | null) => void
  setClipFps: (fps: number | null) => void
  togglePlay: () => void

  toGraph: () => Graph
  structureKey: () => string
}

export const useEditor = create<EditorState>((set, get) => {
  const initial = starterGraph()

  const mapNode = (id: string, fn: (n: GradeNode) => GradeNode) =>
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? fn(n) : n)) }))

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

    onNodesChange: (changes) =>
      set((s) => ({ nodes: applyNodeChanges(changes, s.nodes) as GradeNode[] })),
    onEdgesChange: (changes) => set((s) => ({ edges: applyEdgeChanges(changes, s.edges) })),
    onConnect: (conn) => set((s) => ({ edges: addEdge({ ...conn, id: edgeId() }, s.edges) })),

    addNode: () =>
      set((s) => {
        const node = createEffectNode({ x: 320, y: 280 + s.nodes.length * 8 })
        return { nodes: [...s.nodes, node], selectedId: node.id }
      }),

    addSerialAfter: () =>
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
      }),

    addSerialBefore: () =>
      set((s) => {
        const byId = new Map(s.nodes.map((n) => [n.id, n]))
        let anchorId = s.selectedId
        if (!anchorId) anchorId = s.nodes.find((n) => n.data.role === 'output')?.id ?? null
        const anchor = anchorId ? byId.get(anchorId) : undefined
        if (!anchor) return {}
        if (anchor.data.role === 'input') return insertAfter(s, anchor)
        return insertBefore(s, anchor)
      }),

    deleteNode: (id) =>
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
      }),

    deleteSelected: () => {
      const { selectedId, deleteNode } = get()
      if (selectedId) deleteNode(selectedId)
    },

    resetNode: (id) =>
      mapNode(id, (n) => ({
        ...n,
        data: {
          ...n.data,
          fx: n.data.fx.map((f) => ({ ...f, values: defaultValues(registry.require(f.type)) })),
        },
      })),

    toggleNodeEnabled: (id) =>
      mapNode(id, (n) =>
        n.data.role === 'effect' ? { ...n, data: { ...n.data, enabled: !n.data.enabled } } : n,
      ),

    setNodeLabel: (id, label) => mapNode(id, (n) => ({ ...n, data: { ...n.data, label } })),

    setNodeAccent: (id, accent) => mapNode(id, (n) => ({ ...n, data: { ...n.data, accent } })),

    addCorrectorAt: (pos) =>
      set((s) => {
        const node = createEffectNode(pos)
        return { nodes: [...s.nodes, node], selectedId: node.id }
      }),

    selectNode: (id) => set({ selectedId: id }),

    updateFxValues: (nodeId, fid, patch) =>
      mapNode(nodeId, (n) => ({
        ...n,
        data: {
          ...n.data,
          fx: n.data.fx.map((f) =>
            f.id === fid ? { ...f, values: { ...f.values, ...patch } } : f,
          ),
        },
      })),

    setActiveFx: (id) => set({ activeFxId: id }),

    addFx: (nodeId, type) =>
      set((s) => {
        const fx = makeFx(type)
        return {
          nodes: s.nodes.map((n) =>
            n.id === nodeId ? { ...n, data: { ...n.data, fx: [...n.data.fx, fx] } } : n,
          ),
          activeFxId: fx.id, // jump to the freshly added FX tab
        }
      }),

    removeFx: (nodeId, fid) =>
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, fx: n.data.fx.filter((f) => f.id !== fid || f.base) } }
            : n,
        ),
        activeFxId: s.activeFxId === fid ? null : s.activeFxId,
      })),

    setCommandOpen: (open) => set({ commandOpen: open }),
    setVideo: (video) => set({ video }),
    setCanvas: (canvas) => set({ canvas }),
    setEngine: (engine) => set({ engine }),
    setClipName: (clipName) => set({ clipName }),
    setClipFps: (clipFps) => set({ clipFps }),

    togglePlay: () => {
      const v = get().video
      if (!v) return
      if (v.paused) void v.play().catch(() => {})
      else v.pause()
    },

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
