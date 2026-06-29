import type { Graph, NodeRegistry } from '@grade/nodes'
import { type CompiledPass, compileGraph, packParams } from './compile'

const WORKING_FORMAT: GPUTextureFormat = 'rgba16float'

/** copyTextureToBuffer requires each row aligned to 256 bytes. */
function alignBytesPerRow(width: number): number {
  return Math.ceil((width * 4) / 256) * 256
}

/** Identity N³ RGB lattice (red-fastest) — maps every colour to itself. */
function identityLut(size: number): Float32Array {
  const out = new Float32Array(size * size * size * 3)
  let p = 0
  const d = size - 1
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        out[p++] = r / d
        out[p++] = g / d
        out[p++] = b / d
      }
    }
  }
  return out
}

export interface EngineInfo {
  adapter: string
  features: string[]
}

/** A graded frame read back off the GPU for the scopes / chroma-warp overlay. */
export interface ScopeFrame {
  data: Uint8ClampedArray
  format: 'RGBA' | 'BGRA'
  width: number
  height: number
}

interface RuntimePass extends CompiledPass {
  pipeline: GPUComputePipeline
  uniform: GPUBuffer
}

/** HTMLVideoElement augmented with the (still partially-typed) rVFC API. */
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

/**
 * The WebGPU render graph runtime. Owns the device, the source frame texture,
 * a pair of ping-pong working textures, one compute pipeline per effect node,
 * and a blit pipeline that draws the final texture to the canvas.
 */
export class Engine {
  private device: GPUDevice
  private context: GPUCanvasContext
  private canvasFormat: GPUTextureFormat
  private registry: NodeRegistry

  private source?: HTMLVideoElement
  private sourceTex?: GPUTexture
  private workA?: GPUTexture
  private workB?: GPUTexture
  private width = 0
  private height = 0

  // Offscreen render target + mappable buffer for pixel readback during export.
  private readbackTex: GPUTexture | undefined = undefined
  private readbackBuf: GPUBuffer | undefined = undefined

  // The live loop's most recent final texture, kept so scopes can reblit it off
  // the GPU without re-importing the video or re-running the chain (which is
  // export-only — it mutates shared textures and is unsafe during playback).
  private lastFinal: GPUTextureView | undefined = undefined
  // Small readback target + buffer for scopes, sized to the scope's analysis
  // resolution rather than the full frame.
  private scopeTex: GPUTexture | undefined = undefined
  private scopeBuf: GPUBuffer | undefined = undefined
  private scopeW = 0
  private scopeH = 0
  // Coalesce concurrent same-size readbacks (the scopes panel + the chroma-warp
  // overlay both sample) so they share one GPU readback instead of racing on the
  // single scope buffer.
  private scopeInflight: Promise<ScopeFrame | null> | null = null
  private scopeInflightKey = ''

  // Histogram tap: the pass whose *input* texture we snapshot each frame (the
  // signal entering a node, before its own grade) so the curve editor can show
  // an upstream distribution. Captured into a dedicated small target during the
  // live loop, then read back on demand.
  private histPassId: string | null = null
  // Whether the histogram tap snapshots the pass's input (signal before its
  // grade) or output (after). Lets the curve editor compare pre/post.
  private histMode: 'input' | 'output' = 'input'
  private histReady = false
  private histTex: GPUTexture | undefined = undefined
  private histBuf: GPUBuffer | undefined = undefined
  private histW = 0
  private histH = 0

  private graph?: Graph
  private passes: RuntimePass[] = []

  private bindLayout: GPUBindGroupLayout
  /** Bind layout for `lut` nodes: the base three bindings plus the 3D LUT. */
  private lutBindLayout: GPUBindGroupLayout
  private blitPipeline: GPURenderPipeline
  private sampler: GPUSampler

  // Per-node 3D LUT textures (set via setNodeLut), plus an identity LUT that
  // stands in for any `lut` pass whose table hasn't been loaded yet.
  private lutTextures = new Map<string, GPUTexture>()
  private defaultLut: GPUTexture

  // Per-frame globals (binding 4 on every pass): time in seconds + a render
  // counter. Reused buffer + scratch array so the per-frame write doesn't
  // allocate.
  private globalUniform: GPUBuffer
  private globalData = new Float32Array(4)
  private frameCounter = 0

  private raf = 0
  private running = false

  /** True once the source video has presented at least one decodable frame. */
  private frameReady = false
  private rvfcHandle = 0

  readonly info: EngineInfo

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    canvasFormat: GPUTextureFormat,
    registry: NodeRegistry,
    info: EngineInfo,
  ) {
    this.device = device
    this.context = context
    this.canvasFormat = canvasFormat
    this.registry = registry
    this.info = info
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })

    const baseEntries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format: WORKING_FORMAT },
      },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      // Per-frame globals (time/frame), shared by every pass.
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ]
    this.bindLayout = device.createBindGroupLayout({ entries: baseEntries })
    this.lutBindLayout = device.createBindGroupLayout({
      entries: [
        ...baseEntries,
        // rgba32float is unfilterable; the shader does manual trilinear sampling.
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '3d' },
        },
      ],
    })

    // Per-frame globals buffer (one vec4: time, frame, pad, pad).
    this.globalUniform = device.createBuffer({
      size: this.globalData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // 2³ identity LUT — the unit-cube corners, so an un-loaded LUT pass is a
    // pass-through.
    this.defaultLut = this.createLutTexture(2, identityLut(2))

    this.blitPipeline = this.createBlitPipeline()
  }

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator
  }

  static async create(canvas: HTMLCanvasElement, registry: NodeRegistry): Promise<Engine> {
    if (!Engine.isSupported()) {
      throw new Error('WebGPU is not available in this browser.')
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('No suitable GPU adapter found.')
    const device = await adapter.requestDevice()
    const context = canvas.getContext('webgpu')
    if (!context) throw new Error('Could not acquire a WebGPU canvas context.')

    const canvasFormat = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format: canvasFormat, alphaMode: 'opaque' })

    const info: EngineInfo = {
      adapter:
        (adapter as unknown as { info?: { description?: string } }).info?.description ?? 'GPU',
      features: [...device.features].map(String),
    }
    return new Engine(device, context, canvasFormat, registry, info)
  }

  /** Provide the imported clip. Triggers a rebuild once dimensions are known. */
  setSource(video: HTMLVideoElement) {
    // Detach any previous frame-callback loop.
    const prev = this.source as VideoWithFrameCallback | undefined
    if (prev && this.rvfcHandle && prev.cancelVideoFrameCallback) {
      prev.cancelVideoFrameCallback(this.rvfcHandle)
    }
    this.rvfcHandle = 0
    this.frameReady = false
    this.source = video

    // requestVideoFrameCallback fires only when a frame is actually presentable,
    // which is exactly when copyExternalImageToTexture is guaranteed a backing
    // resource. Once we've seen one frame, the element always holds at least the
    // last decoded frame, so the flag can stay latched.
    const vfc = video as VideoWithFrameCallback
    if (typeof vfc.requestVideoFrameCallback === 'function') {
      const onFrame = () => {
        this.frameReady = true
        this.rvfcHandle = vfc.requestVideoFrameCallback(onFrame)
      }
      this.rvfcHandle = vfc.requestVideoFrameCallback(onFrame)
    } else {
      // No rVFC (e.g. older Safari): fall back to readyState + try/catch in the
      // render loop.
      this.frameReady = true
    }

    const w = video.videoWidth
    const h = video.videoHeight
    if (w > 0 && h > 0) this.allocate(w, h)
  }

  /** Compile a new node graph into compute passes. */
  setGraph(graph: Graph) {
    this.graph = graph
    this.rebuildPasses()
  }

  /**
   * Upload (or clear) the 3D LUT for a `lut` node. `nodeId` is the compiled pass
   * id (the app keys these `${nodeId}:${fxId}`). Pass `null` to drop back to the
   * identity LUT. Independent of pipeline rebuilds, so loading a LUT doesn't
   * recompile shaders.
   */
  setNodeLut(nodeId: string, lut: { size: number; data: Float32Array } | null): void {
    const existing = this.lutTextures.get(nodeId)
    if (existing) {
      existing.destroy()
      this.lutTextures.delete(nodeId)
    }
    if (lut) this.lutTextures.set(nodeId, this.createLutTexture(lut.size, lut.data))
  }

  /** Live-update a single node's params without recompiling pipelines. */
  setNodeValues(nodeId: string, values: Record<string, number | string | boolean>) {
    const pass = this.passes.find((p) => p.nodeId === nodeId)
    if (!pass) return
    pass.paramData = packParams(pass.def, values)
    this.device.queue.writeBuffer(pass.uniform, 0, pass.paramData)
  }

  start() {
    if (this.running) return
    this.running = true
    const loop = () => {
      if (!this.running) return
      this.renderFrame()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop() {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  /**
   * Copy the current video frame, run the effect chain, blit to canvas.
   * Returns `true` if a frame was actually rendered, or `false` if it was
   * skipped (no source, frame not yet presentable, or the import failed this
   * tick). Export uses the return value to retry until a real frame lands.
   */
  renderFrame(): boolean {
    const encoder = this.device.createCommandEncoder()
    const finalView = this.runChain(encoder)
    if (!finalView) return false
    this.blit(encoder, this.context.getCurrentTexture().createView(), finalView)
    this.device.queue.submit([encoder.finish()])
    // Retain the just-rendered output so sampleScopes() can reblit it.
    this.lastFinal = finalView
    return true
  }

  /**
   * Read the most recently rendered frame back off the GPU at the given (small)
   * resolution, for the video scopes. Safe to call repeatedly *during* live
   * playback — unlike readFrame(), it doesn't touch the source/working textures,
   * it just reblits the retained final view into a dedicated readback target.
   * Returns null until the live loop has rendered at least one frame.
   */
  async sampleScopes(width: number, height: number): Promise<ScopeFrame | null> {
    // Share an in-flight readback of the same size between concurrent callers.
    const key = `${width}x${height}`
    if (this.scopeInflight && this.scopeInflightKey === key) return this.scopeInflight
    const p = this.readbackScopes(width, height).finally(() => {
      if (this.scopeInflight === p) this.scopeInflight = null
    })
    this.scopeInflight = p
    this.scopeInflightKey = key
    return p
  }

  private async readbackScopes(width: number, height: number): Promise<ScopeFrame | null> {
    const src = this.lastFinal
    if (!src || this.width === 0) return null
    this.ensureScopeTarget(width, height)
    if (!this.scopeTex || !this.scopeBuf) return null

    const bytesPerRow = alignBytesPerRow(width)
    const encoder = this.device.createCommandEncoder()
    // The blit samples with a linear sampler, so writing into a smaller target
    // downsamples the frame for free.
    this.blit(encoder, this.scopeTex.createView(), src)
    encoder.copyTextureToBuffer(
      { texture: this.scopeTex },
      { buffer: this.scopeBuf, bytesPerRow, rowsPerImage: height },
      { width, height },
    )
    this.device.queue.submit([encoder.finish()])

    await this.scopeBuf.mapAsync(GPUMapMode.READ)
    const padded = new Uint8Array(this.scopeBuf.getMappedRange())
    const rowBytes = width * 4
    const tight = new Uint8ClampedArray(rowBytes * height)
    for (let y = 0; y < height; y++) {
      tight.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes)
    }
    this.scopeBuf.unmap()

    const format = this.canvasFormat.startsWith('bgra') ? 'BGRA' : 'RGBA'
    return { data: tight, format, width, height }
  }

  /** Lazily (re)allocate the scope readback target + buffer to the given size. */
  private ensureScopeTarget(w: number, h: number): void {
    if (this.scopeTex && this.scopeW === w && this.scopeH === h) return
    this.scopeTex?.destroy()
    this.scopeBuf?.destroy()
    this.scopeW = w
    this.scopeH = h
    this.scopeTex = this.device.createTexture({
      size: { width: w, height: h },
      format: this.canvasFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
    this.scopeBuf = this.device.createBuffer({
      size: alignBytesPerRow(w) * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
  }

  /**
   * Choose which pass the live loop snapshots for the histogram tap, by compiled
   * pass id (`${nodeId}:${fxId}`). Pass null to stop sampling. `mode` selects the
   * signal entering that pass (`'input'`, everything upstream, pre-grade) or
   * leaving it (`'output'`, with the pass's own grade applied).
   */
  setHistogramSource(passId: string | null, mode: 'input' | 'output' = 'input'): void {
    if (passId === this.histPassId && mode === this.histMode) return
    this.histPassId = passId
    this.histMode = mode
    this.histReady = false
  }

  /**
   * Read back the most recent histogram-tap snapshot as tightly-packed 8-bit
   * pixels at the given (small) analysis resolution. Returns null until the live
   * loop has captured a frame for the current source pass. Safe to poll during
   * playback — it only touches the dedicated histogram target.
   */
  async sampleNodeInput(
    width: number,
    height: number,
  ): Promise<{
    data: Uint8ClampedArray
    format: 'RGBA' | 'BGRA'
    width: number
    height: number
  } | null> {
    if (!this.histPassId) return null
    this.ensureHistTarget(width, height)
    if (!this.histTex || !this.histBuf || !this.histReady) return null

    const bytesPerRow = alignBytesPerRow(width)
    const encoder = this.device.createCommandEncoder()
    encoder.copyTextureToBuffer(
      { texture: this.histTex },
      { buffer: this.histBuf, bytesPerRow, rowsPerImage: height },
      { width, height },
    )
    this.device.queue.submit([encoder.finish()])

    await this.histBuf.mapAsync(GPUMapMode.READ)
    const padded = new Uint8Array(this.histBuf.getMappedRange())
    const rowBytes = width * 4
    const tight = new Uint8ClampedArray(rowBytes * height)
    for (let y = 0; y < height; y++) {
      tight.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes)
    }
    this.histBuf.unmap()

    const format = this.canvasFormat.startsWith('bgra') ? 'BGRA' : 'RGBA'
    return { data: tight, format, width, height }
  }

  /** Lazily (re)allocate the histogram-tap target + buffer to the given size. */
  private ensureHistTarget(w: number, h: number): void {
    if (this.histTex && this.histW === w && this.histH === h) return
    this.histTex?.destroy()
    this.histBuf?.destroy()
    this.histW = w
    this.histH = h
    this.histReady = false
    this.histTex = this.device.createTexture({
      size: { width: w, height: h },
      format: this.canvasFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
    this.histBuf = this.device.createBuffer({
      size: alignBytesPerRow(w) * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
  }

  /**
   * Import the current source frame, run the effect chain, and read the graded
   * result back off the GPU as tightly-packed 8-bit pixels. Returns null if no
   * frame was importable this tick. Used by export — reading from a dedicated
   * offscreen texture is deterministic, unlike scraping the presented canvas.
   */
  async readFrame(): Promise<{
    data: Uint8ClampedArray
    format: 'RGBA' | 'BGRA'
    width: number
    height: number
  } | null> {
    const encoder = this.device.createCommandEncoder()
    const finalView = this.runChain(encoder)
    if (!finalView) return null

    this.ensureReadback()
    if (!this.readbackTex || !this.readbackBuf) return null

    const w = this.width
    const h = this.height
    const bytesPerRow = alignBytesPerRow(w)
    this.blit(encoder, this.readbackTex.createView(), finalView)
    encoder.copyTextureToBuffer(
      { texture: this.readbackTex },
      { buffer: this.readbackBuf, bytesPerRow, rowsPerImage: h },
      { width: w, height: h },
    )
    this.device.queue.submit([encoder.finish()])

    await this.readbackBuf.mapAsync(GPUMapMode.READ)
    const padded = new Uint8Array(this.readbackBuf.getMappedRange())
    const rowBytes = w * 4
    const tight = new Uint8ClampedArray(rowBytes * h)
    for (let y = 0; y < h; y++) {
      tight.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes)
    }
    this.readbackBuf.unmap()

    const format = this.canvasFormat.startsWith('bgra') ? 'BGRA' : 'RGBA'
    return { data: tight, format, width: w, height: h }
  }

  /** The canvas the final graded frame is presented to. */
  get outputCanvas(): HTMLCanvasElement | OffscreenCanvas {
    return this.context.canvas
  }

  /** Intrinsic size of the current source/working textures (0 until a clip
   *  with known dimensions has been set). */
  get dimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }

  /** Import the source frame and run the effect chain on `encoder`, returning a
   *  view of the final texture (or null if the frame wasn't importable). */
  private runChain(encoder: GPUCommandEncoder): GPUTextureView | null {
    const video = this.source
    // Wait until the element has decoded a presentable frame; otherwise
    // copyExternalImageToTexture throws "doesn't have back resource".
    if (!video || !this.frameReady || video.readyState < 2 || video.videoWidth === 0) return null

    // (Re)allocate if the clip's intrinsic size just became known or changed.
    if (video.videoWidth && video.videoWidth !== this.width) {
      this.allocate(video.videoWidth, video.videoHeight)
    }
    if (!this.sourceTex || !this.workA || !this.workB) return null

    try {
      this.device.queue.copyExternalImageToTexture(
        { source: video, flipY: false },
        { texture: this.sourceTex },
        { width: this.width, height: this.height },
      )
    } catch {
      // Frame wasn't importable this tick (seek/stall/format hiccup). Skip it;
      // the next presentable frame will re-arm via requestVideoFrameCallback.
      return null
    }

    // Refresh per-frame globals. Time is the clip's own playback position, so
    // grain/temporal effects are deterministic on export (seek → fixed time)
    // and static on a paused frame, yet crawl during playback.
    this.frameCounter += 1
    this.globalData[0] = Number.isFinite(video.currentTime) ? video.currentTime : 0
    this.globalData[1] = this.frameCounter
    this.device.queue.writeBuffer(this.globalUniform, 0, this.globalData)

    // Run the effect chain, ping-ponging A/B. `final` is the output texture.
    let srcView: GPUTextureView = this.sourceTex.createView()
    let final: GPUTexture = this.sourceTex
    let writeToA = true
    for (const pass of this.passes) {
      // Histogram tap (input mode): snapshot this pass's input (everything
      // upstream of it, pre-grade) into the dedicated target before it runs.
      if (this.histMode === 'input' && pass.nodeId === this.histPassId && this.histTex) {
        this.blit(encoder, this.histTex.createView(), srcView)
        this.histReady = true
      }
      const dstTex = writeToA ? this.workA : this.workB
      const cpass = encoder.beginComputePass()
      cpass.setPipeline(pass.pipeline)
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: srcView },
        { binding: 1, resource: dstTex.createView() },
        { binding: 2, resource: { buffer: pass.uniform } },
        { binding: 4, resource: { buffer: this.globalUniform } },
      ]
      if (pass.def.lut) {
        const tex = this.lutTextures.get(pass.nodeId) ?? this.defaultLut
        entries.push({ binding: 3, resource: tex.createView({ dimension: '3d' }) })
      }
      cpass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: pass.def.lut ? this.lutBindLayout : this.bindLayout,
          entries,
        }),
      )
      cpass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8))
      cpass.end()

      srcView = dstTex.createView()
      final = dstTex
      writeToA = !writeToA

      // Histogram tap (output mode): snapshot this pass's output, after its own
      // grade has been applied.
      if (this.histMode === 'output' && pass.nodeId === this.histPassId && this.histTex) {
        this.blit(encoder, this.histTex.createView(), srcView)
        this.histReady = true
      }
    }

    return final.createView()
  }

  /** Draw a sampled texture to a render target (the canvas, or the readback texture). */
  private blit(encoder: GPUCommandEncoder, target: GPUTextureView, src: GPUTextureView): void {
    const rpass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
      ],
    })
    rpass.setPipeline(this.blitPipeline)
    rpass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.blitPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: src },
        ],
      }),
    )
    rpass.draw(3)
    rpass.end()
  }

  /** Lazily (re)allocate the readback target + buffer to the current size. */
  private ensureReadback(): void {
    const w = this.width
    const h = this.height
    if (this.readbackTex && this.readbackTex.width === w && this.readbackTex.height === h) return
    this.readbackTex?.destroy()
    this.readbackBuf?.destroy()
    this.readbackTex = this.device.createTexture({
      size: { width: w, height: h },
      format: this.canvasFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
    this.readbackBuf = this.device.createBuffer({
      size: alignBytesPerRow(w) * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
  }

  dispose() {
    this.stop()
    const src = this.source as VideoWithFrameCallback | undefined
    if (src && this.rvfcHandle && src.cancelVideoFrameCallback) {
      src.cancelVideoFrameCallback(this.rvfcHandle)
    }
    this.rvfcHandle = 0
    this.sourceTex?.destroy()
    this.workA?.destroy()
    this.workB?.destroy()
    this.readbackTex?.destroy()
    this.readbackBuf?.destroy()
    this.scopeTex?.destroy()
    this.scopeBuf?.destroy()
    this.histTex?.destroy()
    this.histBuf?.destroy()
    for (const p of this.passes) p.uniform.destroy()
    this.passes = []
    this.globalUniform.destroy()
    for (const tex of this.lutTextures.values()) tex.destroy()
    this.lutTextures.clear()
    this.defaultLut.destroy()
    this.device.destroy()
  }

  // ---- internals ----

  /**
   * Create an N³ 3D LUT texture from a flat RGB lattice (red-fastest, the
   * `.cube` order). Stored as `rgba32float` (a=1) and sampled with `textureLoad`,
   * so no filterable-float feature is needed.
   */
  private createLutTexture(size: number, rgb: Float32Array): GPUTexture {
    const tex = this.device.createTexture({
      size: { width: size, height: size, depthOrArrayLayers: size },
      dimension: '3d',
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    const rgba = new Float32Array(size * size * size * 4)
    for (let i = 0, j = 0; j < rgba.length; i += 3, j += 4) {
      rgba[j] = rgb[i] ?? 0
      rgba[j + 1] = rgb[i + 1] ?? 0
      rgba[j + 2] = rgb[i + 2] ?? 0
      rgba[j + 3] = 1
    }
    this.device.queue.writeTexture(
      { texture: tex },
      rgba,
      { bytesPerRow: size * 16, rowsPerImage: size },
      { width: size, height: size, depthOrArrayLayers: size },
    )
    return tex
  }

  private allocate(w: number, h: number) {
    if (w === this.width && h === this.height && this.sourceTex) return
    this.width = w
    this.height = h
    this.sourceTex?.destroy()
    this.workA?.destroy()
    this.workB?.destroy()
    // Force readback resources to be rebuilt at the new size on next export.
    this.readbackTex?.destroy()
    this.readbackBuf?.destroy()
    this.readbackTex = undefined
    this.readbackBuf = undefined
    // The retained final view points at textures we're about to destroy, and
    // the scope target may need a different size; drop both.
    this.lastFinal = undefined
    this.scopeTex?.destroy()
    this.scopeBuf?.destroy()
    this.scopeTex = undefined
    this.scopeBuf = undefined
    this.scopeW = 0
    this.scopeH = 0

    this.sourceTex = this.device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT,
    })
    const workUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    this.workA = this.device.createTexture({
      size: { width: w, height: h },
      format: WORKING_FORMAT,
      usage: workUsage,
    })
    this.workB = this.device.createTexture({
      size: { width: w, height: h },
      format: WORKING_FORMAT,
      usage: workUsage,
    })
  }

  private rebuildPasses() {
    for (const p of this.passes) p.uniform.destroy()
    this.passes = []
    if (!this.graph) return

    const compiled = compileGraph(this.graph, this.registry)
    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindLayout],
    })
    const lutPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.lutBindLayout],
    })

    for (const pass of compiled.passes) {
      const module = this.device.createShaderModule({ code: pass.wgsl })
      const pipeline = this.device.createComputePipeline({
        layout: pass.def.lut ? lutPipelineLayout : pipelineLayout,
        compute: { module, entryPoint: 'main' },
      })
      const uniform = this.device.createBuffer({
        size: pass.paramData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(uniform, 0, pass.paramData)
      this.passes.push({ ...pass, pipeline, uniform })
    }

    // Drop LUT textures for nodes that no longer exist in the graph.
    const live = new Set(compiled.passes.map((p) => p.nodeId))
    for (const [id, tex] of this.lutTextures) {
      if (!live.has(id)) {
        tex.destroy()
        this.lutTextures.delete(id)
      }
    }
  }

  private createBlitPipeline(): GPURenderPipeline {
    const module = this.device.createShaderModule({
      code: /* wgsl */ `
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0),
  );
  var out: VSOut;
  let xy = p[i];
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  out.uv = vec2<f32>(xy.x * 0.5 + 0.5, 1.0 - (xy.y * 0.5 + 0.5));
  return out;
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  return textureSample(tex, samp, in.uv);
}
`,
    })
    return this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    })
  }
}
