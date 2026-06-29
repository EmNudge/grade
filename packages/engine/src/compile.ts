// Graph -> ordered effect passes + generated WGSL + packed uniform data.
//
// The graph is walked from the Output sink back to the Input source, producing
// a linear chain of effect nodes (the scaffold supports single-input chains;
// multi-input compositing is a later extension). Each effect becomes one
// compute pass whose WGSL is generated from its NodeDef kernel.

import type { Graph, GraphNode, NodeDef, NodeRegistry, ParamDef } from '@grade/nodes'

export interface CompiledPass {
  nodeId: string
  def: NodeDef
  wgsl: string
  /** Packed uniform data, 16-byte aligned. */
  paramData: Float32Array
}

export interface CompiledGraph {
  passes: CompiledPass[]
  /** Diagnostics for the UI (e.g. "no path from Input to Output"). */
  warnings: string[]
}

/** Pack a node's param values into a 16-byte-aligned f32 buffer. */
export function packParams(def: NodeDef, values: Record<string, unknown>): Float32Array {
  const floats = def.params.map((p) => encodeParam(p, values[p.key]))
  const padded = Math.max(4, Math.ceil(floats.length / 4) * 4)
  const out = new Float32Array(padded)
  out.set(floats)
  return out
}

function encodeParam(p: ParamDef, value: unknown): number {
  switch (p.type) {
    case 'float':
      return typeof value === 'number' ? value : Number(p.default)
    case 'bool':
      return value ? 1 : 0
    case 'enum': {
      const v = value ?? p.default
      const idx = (p.options ?? []).findIndex((o) => o.value === v)
      return idx < 0 ? 0 : idx
    }
    default:
      return 0
  }
}

/**
 * WGSL for sampling a node's 3D LUT. Bound at @binding(3) for `lut` nodes. Uses
 * manual trilinear interpolation over `textureLoad` (rather than a hardware
 * sampler) so the LUT can be a non-filterable `rgba32float` texture — no
 * `float32-filterable` feature and no f16 conversion required. Input is the
 * 0..1 colour; the lattice spans the unit cube.
 */
const LUT_WGSL = /* wgsl */ `
@group(0) @binding(3) var lut: texture_3d<f32>;

fn grade_apply_lut(c_in: vec3<f32>) -> vec3<f32> {
  let n = vec3<i32>(textureDimensions(lut));
  let p = clamp(c_in, vec3<f32>(0.0), vec3<f32>(1.0)) * (vec3<f32>(n) - vec3<f32>(1.0));
  let b0 = vec3<i32>(floor(p));
  let b1 = min(b0 + vec3<i32>(1), n - vec3<i32>(1));
  let f = p - vec3<f32>(b0);
  let c000 = textureLoad(lut, vec3<i32>(b0.x, b0.y, b0.z), 0).rgb;
  let c100 = textureLoad(lut, vec3<i32>(b1.x, b0.y, b0.z), 0).rgb;
  let c010 = textureLoad(lut, vec3<i32>(b0.x, b1.y, b0.z), 0).rgb;
  let c110 = textureLoad(lut, vec3<i32>(b1.x, b1.y, b0.z), 0).rgb;
  let c001 = textureLoad(lut, vec3<i32>(b0.x, b0.y, b1.z), 0).rgb;
  let c101 = textureLoad(lut, vec3<i32>(b1.x, b0.y, b1.z), 0).rgb;
  let c011 = textureLoad(lut, vec3<i32>(b0.x, b1.y, b1.z), 0).rgb;
  let c111 = textureLoad(lut, vec3<i32>(b1.x, b1.y, b1.z), 0).rgb;
  let c00 = mix(c000, c100, f.x);
  let c10 = mix(c010, c110, f.x);
  let c01 = mix(c001, c101, f.x);
  let c11 = mix(c011, c111, f.x);
  return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}
`

/** Generate the WGSL params struct + a single compute shader for an effect node. */
export function generateWgsl(def: NodeDef): string {
  const kernel = def.kernel
  if (!kernel) throw new Error(`Node ${def.type} has no kernel`)

  const fields =
    def.params.length > 0 ? def.params.map((p) => `  ${p.key}: f32,`) : ['  _unused: f32,']
  // pad struct to a multiple of 4 f32 (16 bytes) for uniform layout
  const used = Math.max(1, def.params.length)
  for (let i = used; i % 4 !== 0; i++) fields.push(`  _pad${i}: f32,`)

  return /* wgsl */ `
${kernel.lib ?? ''}

struct Params {
${fields.join('\n')}
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> P: Params;
${def.lut ? LUT_WGSL : ''}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(dst);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);
  var color = texel.rgb;
${kernel.body}
  textureStore(dst, coord, vec4<f32>(color, texel.a));
}
`
}

/** Topologically order the effect chain from Input -> Output. */
export function compileGraph(graph: Graph, registry: NodeRegistry): CompiledGraph {
  const warnings: string[] = []
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const out = (id: string) => graph.edges.filter((e) => e.from === id).map((e) => e.to)

  const input = graph.nodes.find((n) => registry.get(n.type)?.role === 'input')
  const output = graph.nodes.find((n) => registry.get(n.type)?.role === 'output')
  if (!input) warnings.push('No Input node — nothing to read.')
  if (!output) warnings.push('No Viewer/Output node — nothing to display.')

  // Walk forward from input, following the first outgoing edge each step, until
  // we reach the output sink. Collect effect nodes in order.
  const passes: CompiledPass[] = []
  if (input && output) {
    const seen = new Set<string>()
    let reachedOutput = false
    let current: GraphNode | undefined = input
    while (current) {
      if (current.id === output.id) {
        reachedOutput = true
        break
      }
      if (seen.has(current.id)) {
        warnings.push('Cycle detected in graph; stopping.')
        break
      }
      seen.add(current.id)
      const def = registry.get(current.type)
      // Bypassed nodes (enabled === false) emit no pass — the signal passes through.
      if (def?.role === 'effect' && def.kernel && current.enabled !== false) {
        passes.push({
          nodeId: current.id,
          def,
          wgsl: generateWgsl(def),
          paramData: packParams(def, current.values),
        })
      }
      const nextId: string | undefined = out(current.id)[0]
      current = nextId ? byId.get(nextId) : undefined
    }
    if (!reachedOutput) warnings.push('Input is not connected to the Viewer.')
  }

  return { passes, warnings }
}
