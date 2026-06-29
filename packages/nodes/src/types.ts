// The node SDK. A node type is a pure declaration: its parameters and a WGSL
// kernel. The engine turns each instance into one GPU compute pass. Plugins add
// node types by registering a `NodeDef` — no engine changes required.

export type ParamType = 'float' | 'enum' | 'bool'

export interface ParamDef {
  /** Stable key; also the field name exposed to WGSL as `P.<key>`. */
  key: string
  label: string
  type: ParamType
  /** Optional section heading the inspector groups consecutive params under. */
  group?: string
  /** Default value. number for float/enum-index/bool, or enum option value. */
  default: number | string | boolean
  // float-only
  min?: number
  max?: number
  step?: number
  // enum-only
  options?: ReadonlyArray<{ value: string; label: string }>
}

export interface KernelSpec {
  /**
   * WGSL injected once at module scope (helper fns, color libs). Deduplicated
   * by the compiler across nodes sharing the same `lib` string.
   */
  lib?: string
  /**
   * Per-pixel body. Receives `color: vec3<f32>` (input RGB, mutable) and `P`
   * (the params uniform). Mutate `color` to produce the output. Example:
   *   color = (color - 0.5) * P.contrast + 0.5 + P.brightness;
   */
  body: string
}

export type NodeRole = 'input' | 'effect' | 'output'

export interface NodeDef {
  /** Unique type id, e.g. 'contrast-brightness'. */
  type: string
  label: string
  category: string
  /**
   * When true this effect is an *FX* — attachable to a corrector node's FX
   * stack rather than placed as its own graph node (e.g. Glow, Color Space).
   */
  fx?: boolean
  /**
   * 'input' sources frames (no GPU pass; provides the source texture).
   * 'effect' is one compute pass. 'output' marks the graph sink (no-op pass).
   */
  role: NodeRole
  /**
   * When true this node samples a per-instance 3D LUT. The engine binds the
   * uploaded LUT texture (set via `Engine.setNodeLut`) and the compiler exposes
   * a `grade_apply_lut(vec3<f32>) -> vec3<f32>` helper to the kernel body. An
   * identity LUT stands in until one is loaded.
   */
  lut?: boolean
  params: ReadonlyArray<ParamDef>
  /** Required for 'effect' nodes; ignored for input/output. */
  kernel?: KernelSpec
  /** UI accent color for the node header. */
  accent?: string
}

/** A concrete node placed on the graph. */
export interface GraphNode {
  id: string
  type: string
  /** Param values keyed by ParamDef.key. */
  values: Record<string, number | string | boolean>
  /** When false, the node is bypassed (no pass emitted). Defaults to enabled. */
  enabled?: boolean
}

export interface GraphEdge {
  from: string // source node id
  to: string // target node id
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}
