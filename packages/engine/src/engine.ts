import type { Graph, NodeRegistry } from '@grade/nodes'
import { type CompiledPass, compileGraph, packParams } from './compile'

const WORKING_FORMAT: GPUTextureFormat = 'rgba16float'

/** copyTextureToBuffer requires each row aligned to 256 bytes. */
function alignBytesPerRow(width: number): number {
  return Math.ceil((width * 4) / 256) * 256
}

export interface EngineInfo {
  adapter: string
  features: string[]
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

  private graph?: Graph
  private passes: RuntimePass[] = []

  private bindLayout: GPUBindGroupLayout
  private blitPipeline: GPURenderPipeline
  private sampler: GPUSampler

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

    this.bindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: WORKING_FORMAT },
        },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    })

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
    return true
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

    // Run the effect chain, ping-ponging A/B. `final` is the output texture.
    let srcView: GPUTextureView = this.sourceTex.createView()
    let final: GPUTexture = this.sourceTex
    let writeToA = true
    for (const pass of this.passes) {
      const dstTex = writeToA ? this.workA : this.workB
      const cpass = encoder.beginComputePass()
      cpass.setPipeline(pass.pipeline)
      cpass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: this.bindLayout,
          entries: [
            { binding: 0, resource: srcView },
            { binding: 1, resource: dstTex.createView() },
            { binding: 2, resource: { buffer: pass.uniform } },
          ],
        }),
      )
      cpass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8))
      cpass.end()

      srcView = dstTex.createView()
      final = dstTex
      writeToA = !writeToA
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
    for (const p of this.passes) p.uniform.destroy()
    this.passes = []
    this.device.destroy()
  }

  // ---- internals ----

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

    for (const pass of compiled.passes) {
      const module = this.device.createShaderModule({ code: pass.wgsl })
      const pipeline = this.device.createComputePipeline({
        layout: pipelineLayout,
        compute: { module, entryPoint: 'main' },
      })
      const uniform = this.device.createBuffer({
        size: pass.paramData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(uniform, 0, pass.paramData)
      this.passes.push({ ...pass, pipeline, uniform })
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
