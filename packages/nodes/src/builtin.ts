import { COLOR_WGSL_LIB } from '@grade/color'
import { NodeRegistry } from './registry'
import type { NodeDef, ParamDef } from './types'

/** Source node — provides the imported clip's frames as the graph source. */
export const INPUT_NODE: NodeDef = {
  type: 'input',
  label: 'Media In',
  category: 'I/O',
  role: 'input',
  accent: '#3b82f6',
  params: [],
}

/** Sink node — the viewer reads whatever feeds this. */
export const OUTPUT_NODE: NodeDef = {
  type: 'output',
  label: 'Viewer Out',
  category: 'I/O',
  role: 'output',
  accent: '#22c55e',
  params: [],
}

/**
 * Color Space Transform: camera log/gamut -> Rec.709.
 * Decodes the source log curve, maps its gamut -> Rec.709 primaries, then
 * encodes for display. DJI D-Log -> Rec.709 is the default. `amount` dials the
 * transform in/out for A/B comparison.
 */
export const COLOR_SPACE_NODE: NodeDef = {
  type: 'color-space',
  label: 'Color Space Transform',
  category: 'Color',
  role: 'effect',
  fx: true,
  accent: '#a855f7',
  params: [
    {
      key: 'source',
      label: 'Source',
      type: 'enum',
      // Default = DJI D-Log -> Rec.709.
      default: 'dji-dlog',
      options: [
        { value: 'dji-dlog', label: 'DJI D-Log / D-Log M' },
        { value: 'sony-slog3', label: 'Sony S-Log3 / S-Gamut3.Cine' },
        { value: 'arri-logc3', label: 'ARRI LogC3 (EI 800) / AWG3' },
        { value: 'rec709', label: 'Rec.709 (passthrough)' },
      ],
    },
    {
      key: 'display',
      label: 'Output Encode',
      type: 'enum',
      default: 'gamma24',
      options: [
        { value: 'gamma24', label: 'Rec.709 (Gamma 2.4)' },
        { value: 'gamma22', label: 'Rec.709 (Gamma 2.2)' },
        { value: 'bt709', label: 'Rec.709 (BT.709 OETF)' },
      ],
    },
    {
      key: 'amount',
      label: 'Amount',
      type: 'float',
      default: 1,
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],
  kernel: {
    lib: COLOR_WGSL_LIB,
    // P.source: 0 DJI, 1 S-Log3, 2 LogC3, 3 passthrough.
    // P.display: 0 gamma2.4, 1 gamma2.2, 2 BT.709 OETF.
    body: /* wgsl */ `
      var graded = color;
      if (P.source < 2.5) {
        let lin = grade_source_to_rec709_linear(color, P.source);
        graded = grade_encode_display(lin, P.display);
      }
      color = mix(color, graded, P.amount);
    `,
  },
}

/**
 * Contrast / Brightness — the canonical "first node". Pivots contrast around
 * mid-gray, then offsets brightness.
 */
export const CONTRAST_BRIGHTNESS_NODE: NodeDef = {
  type: 'contrast-brightness',
  label: 'Contrast / Brightness',
  category: 'FX',
  role: 'effect',
  fx: true,
  accent: '#f59e0b',
  params: [
    {
      key: 'contrast',
      label: 'Contrast',
      type: 'float',
      default: 1,
      min: 0,
      max: 2,
      step: 0.01,
    },
    {
      key: 'brightness',
      label: 'Brightness',
      type: 'float',
      default: 0,
      min: -0.5,
      max: 0.5,
      step: 0.005,
    },
  ],
  kernel: {
    body: /* wgsl */ `
      color = (color - vec3<f32>(0.5)) * P.contrast + vec3<f32>(0.5) + vec3<f32>(P.brightness);
    `,
  },
}

/** Build the 4 params (master + R/G/B) for one LGGO band. */
function band(
  prefix: string,
  group: string,
  masterDefault: number,
  masterMin: number,
  masterMax: number,
  chRange: number,
): ParamDef[] {
  const mk = (suffix: string, label: string, def: number, min: number, max: number): ParamDef => ({
    key: `${prefix}_${suffix}`,
    label,
    group,
    type: 'float',
    default: def,
    min,
    max,
    step: 0.005,
  })
  return [
    mk('m', 'Master', masterDefault, masterMin, masterMax),
    mk('r', 'R', 0, -chRange, chRange),
    mk('g', 'G', 0, -chRange, chRange),
    mk('b', 'B', 0, -chRange, chRange),
  ]
}

/** Max control points per curve channel. Default curve is 2 points (linear). */
export const CURVE_MAX = 5
function curvePts(channel: string): ParamDef[] {
  const out: ParamDef[] = [
    {
      key: `crv${channel}_n`,
      label: 'n',
      group: 'Curves',
      type: 'float',
      default: 2,
      min: 2,
      max: CURVE_MAX,
      step: 1,
    },
  ]
  for (let i = 0; i < CURVE_MAX; i++) {
    // Defaults: point 0 at (0,0), all others at (1,1) -> a straight identity line.
    const d = i === 0 ? 0 : 1
    out.push(
      {
        key: `crv${channel}_x${i}`,
        label: `x${i}`,
        group: 'Curves',
        type: 'float',
        default: d,
        min: 0,
        max: 1,
        step: 0.001,
      },
      {
        key: `crv${channel}_y${i}`,
        label: `y${i}`,
        group: 'Curves',
        type: 'float',
        default: d,
        min: 0,
        max: 1,
        step: 0.001,
      },
    )
  }
  return out
}

const curveCall = (ch: string, inp: string) =>
  `grade_curveN(${inp}, P.crv${ch}_n, ` +
  `P.crv${ch}_x0, P.crv${ch}_x1, P.crv${ch}_x2, P.crv${ch}_x3, P.crv${ch}_x4, ` +
  `P.crv${ch}_y0, P.crv${ch}_y1, P.crv${ch}_y2, P.crv${ch}_y3, P.crv${ch}_y4, P.crv_smooth)`

/** Chroma Warp hue sectors (the 6 around the wheel), used by the shader + UI. */
export const CHROMA_HUES = [
  { key: 'r', label: 'Red', color: '#ff5a5a' },
  { key: 'y', label: 'Yellow', color: '#ffd25a' },
  { key: 'g', label: 'Green', color: '#5aff7d' },
  { key: 'c', label: 'Cyan', color: '#5affff' },
  { key: 'b', label: 'Blue', color: '#5a7dff' },
  { key: 'm', label: 'Magenta', color: '#d25aff' },
] as const

function chromaParams(): ParamDef[] {
  return CHROMA_HUES.flatMap((h): ParamDef[] => [
    {
      key: `cw_h_${h.key}`,
      label: `${h.label} Hue`,
      group: 'Chroma',
      type: 'float',
      default: 0,
      min: -1,
      max: 1,
      step: 0.01,
    },
    {
      key: `cw_s_${h.key}`,
      label: `${h.label} Sat`,
      group: 'Chroma',
      type: 'float',
      default: 1,
      min: 0,
      max: 2,
      step: 0.01,
    },
  ])
}

/**
 * Color Correction — Lift / Gamma / Gain / Offset color wheels plus per-channel
 * tone Curves (variable control points, linear interpolation). Lift sets the
 * black point, Gain the white point, Gamma the midtones. This is the base of
 * every corrector node.
 */
export const COLOR_CORRECT_NODE: NodeDef = {
  type: 'color-correct',
  label: 'Lift / Gamma / Gain',
  category: 'Color',
  role: 'effect',
  accent: '#f59e0b',
  params: [
    ...band('lift', 'Lift', 0, -0.5, 0.5, 0.5),
    ...band('gamma', 'Gamma', 1, 0.2, 3, 0.5),
    ...band('gain', 'Gain', 1, 0, 3, 0.5),
    ...band('offset', 'Offset', 0, -0.3, 0.3, 0.3),
    ...curvePts('m'),
    ...curvePts('r'),
    ...curvePts('g'),
    ...curvePts('b'),
    { key: 'crv_smooth', label: 'Smooth', type: 'bool', default: false, group: 'Curves' },
    ...chromaParams(),
  ],
  kernel: {
    lib: /* wgsl */ `
      // Curve over up to ${CURVE_MAX} sorted control points. Linear, or a
      // Catmull-Rom spline through the points when smoothing > 0.5.
      // (Note: 'smooth' is a reserved word in WGSL, so the param is 'smoothing'.)
      fn grade_curveN(
        x: f32, n: f32,
        x0: f32, x1: f32, x2: f32, x3: f32, x4: f32,
        y0: f32, y1: f32, y2: f32, y3: f32, y4: f32,
        smoothing: f32,
      ) -> f32 {
        var xs = array<f32, 5>(x0, x1, x2, x3, x4);
        var ys = array<f32, 5>(y0, y1, y2, y3, y4);
        let cnt = i32(n + 0.5);
        let xc = clamp(x, 0.0, 1.0);
        if (xc <= xs[0]) { return ys[0]; }
        for (var i = 0; i < cnt - 1; i = i + 1) {
          if (xc <= xs[i + 1]) {
            let t = (xc - xs[i]) / max(xs[i + 1] - xs[i], 1e-5);
            if (smoothing > 0.5) {
              let p0 = ys[max(i - 1, 0)];
              let p1 = ys[i];
              let p2 = ys[i + 1];
              let p3 = ys[min(i + 2, cnt - 1)];
              let t2 = t * t;
              let t3 = t2 * t;
              return 0.5 * ((2.0 * p1) + (-p0 + p2) * t
                + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
                + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
            }
            return mix(ys[i], ys[i + 1], t);
          }
        }
        return ys[cnt - 1];
      }

      fn grade_rgb2hsv(c: vec3<f32>) -> vec3<f32> {
        let K = vec4<f32>(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
        let p = mix(vec4<f32>(c.bg, K.wz), vec4<f32>(c.gb, K.xy), step(c.b, c.g));
        let q = mix(vec4<f32>(p.xyw, c.r), vec4<f32>(c.r, p.yzx), step(p.x, c.r));
        let d = q.x - min(q.w, q.y);
        let e = 1e-10;
        return vec3<f32>(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
      }
      fn grade_hsv2rgb(c: vec3<f32>) -> vec3<f32> {
        let K = vec4<f32>(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
        let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        return c.z * mix(K.xxx, clamp(p - K.xxx, vec3<f32>(0.0), vec3<f32>(1.0)), c.y);
      }
    `,
    body: /* wgsl */ `
      let lift = vec3<f32>(P.lift_m) + vec3<f32>(P.lift_r, P.lift_g, P.lift_b);
      let gamma = vec3<f32>(P.gamma_m) + vec3<f32>(P.gamma_r, P.gamma_g, P.gamma_b);
      let gain = vec3<f32>(P.gain_m) + vec3<f32>(P.gain_r, P.gain_g, P.gain_b);
      let offset = vec3<f32>(P.offset_m) + vec3<f32>(P.offset_r, P.offset_g, P.offset_b);
      // lift = black point, gain = white point, then offset, then gamma (mids).
      color = color * (gain - lift) + lift;
      color = color + offset;
      color = pow(max(color, vec3<f32>(0.0)), vec3<f32>(1.0) / max(gamma, vec3<f32>(0.0001)));
      // per-channel tone curves, then the master curve.
      color = vec3<f32>(${curveCall('r', 'color.r')}, ${curveCall('g', 'color.g')}, ${curveCall('b', 'color.b')});
      color = vec3<f32>(${curveCall('m', 'color.r')}, ${curveCall('m', 'color.g')}, ${curveCall('m', 'color.b')});

      // Chroma Warp: per-hue hue-shift + saturation, blended around the wheel.
      var hsv = grade_rgb2hsv(max(color, vec3<f32>(0.0)));
      var cwH = array<f32, 6>(P.cw_h_r, P.cw_h_y, P.cw_h_g, P.cw_h_c, P.cw_h_b, P.cw_h_m);
      var cwS = array<f32, 6>(P.cw_s_r, P.cw_s_y, P.cw_s_g, P.cw_s_c, P.cw_s_b, P.cw_s_m);
      let h6 = fract(hsv.x) * 6.0;
      let si = i32(floor(h6)) % 6;
      let sj = (si + 1) % 6;
      let sf = fract(h6);
      let dHue = mix(cwH[si], cwH[sj], sf) * 0.1; // ±1 -> ±36°
      let mSat = mix(cwS[si], cwS[sj], sf);
      hsv.x = fract(hsv.x + dHue);
      hsv.y = clamp(hsv.y * mSat, 0.0, 1.0);
      color = grade_hsv2rgb(hsv);
    `,
  },
}

/**
 * Glow — blooms the highlights. Bright-passes the image above a threshold,
 * box-blurs it over a radius, and adds it back. Samples neighbours from the
 * source texture (the kernel has `src`/`coord`/`dims` in scope).
 */
export const GLOW_NODE: NodeDef = {
  type: 'glow',
  label: 'Glow',
  category: 'FX',
  role: 'effect',
  fx: true,
  accent: '#ec4899',
  params: [
    {
      key: 'intensity',
      label: 'Intensity',
      type: 'float',
      default: 0.6,
      min: 0,
      max: 2,
      step: 0.01,
    },
    {
      key: 'threshold',
      label: 'Threshold',
      type: 'float',
      default: 0.6,
      min: 0,
      max: 1,
      step: 0.01,
    },
    { key: 'radius', label: 'Radius', type: 'float', default: 2, min: 0.5, max: 6, step: 0.1 },
  ],
  kernel: {
    body: /* wgsl */ `
      let maxc = vec2<i32>(vec2<i32>(dims) - vec2<i32>(1));
      var glow = vec3<f32>(0.0);
      for (var dy = -2; dy <= 2; dy = dy + 1) {
        for (var dx = -2; dx <= 2; dx = dx + 1) {
          let o = vec2<i32>(i32(f32(dx) * P.radius), i32(f32(dy) * P.radius));
          let sc = clamp(coord + o, vec2<i32>(0, 0), maxc);
          let s = textureLoad(src, sc, 0).rgb;
          glow += max(s - vec3<f32>(P.threshold), vec3<f32>(0.0));
        }
      }
      color = color + (glow / 25.0) * P.intensity;
    `,
  },
}

/**
 * Halation — the warm glow film gets around bright highlights, where light
 * passes through the emulsion, scatters off the film base and re-exposes the
 * surrounding grains (mostly in red, since the anti-halation backing absorbs it
 * least). Luma highlight bright-pass -> soft blur -> red/orange tint, screened
 * back over the image.
 */
export const HALATION_NODE: NodeDef = {
  type: 'halation',
  label: 'Halation',
  category: 'FX',
  role: 'effect',
  fx: true,
  accent: '#ff5a36',
  params: [
    {
      key: 'intensity',
      label: 'Intensity',
      type: 'float',
      default: 0.7,
      min: 0,
      max: 2,
      step: 0.01,
    },
    {
      key: 'threshold',
      label: 'Threshold',
      type: 'float',
      default: 0.65,
      min: 0,
      max: 1,
      step: 0.01,
    },
    { key: 'size', label: 'Size', type: 'float', default: 3, min: 0.5, max: 8, step: 0.1 },
    // 0 = deep red, 1 = orange.
    { key: 'tint', label: 'Tint', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01 },
  ],
  kernel: {
    body: /* wgsl */ `
      let maxc = vec2<i32>(vec2<i32>(dims) - vec2<i32>(1));
      var h = 0.0;
      for (var dy = -2; dy <= 2; dy = dy + 1) {
        for (var dx = -2; dx <= 2; dx = dx + 1) {
          let o = vec2<i32>(i32(f32(dx) * P.size), i32(f32(dy) * P.size));
          let sc = clamp(coord + o, vec2<i32>(0, 0), maxc);
          let s = textureLoad(src, sc, 0).rgb;
          let luma = dot(s, vec3<f32>(0.2126, 0.7152, 0.0722));
          h += max(luma - P.threshold, 0.0);
        }
      }
      h = (h / 25.0) * P.intensity;
      let tint = mix(vec3<f32>(1.0, 0.18, 0.06), vec3<f32>(1.0, 0.5, 0.2), P.tint);
      let halo = clamp(h, 0.0, 1.0) * tint;
      // screen blend so highlights bloom softly rather than clip.
      color = vec3<f32>(1.0) - (vec3<f32>(1.0) - color) * (vec3<f32>(1.0) - halo);
    `,
  },
}

/**
 * Film Look — an analytic film-stock emulation. The full tools (Dehancer,
 * FilmConvert, Resolve's Film Look Creator) use measured spectral density / 3D
 * LUTs; this approximates the *look* with the same stages: a filmic S-curve
 * (toe + shoulder), gentle desaturation with highlight bleach, a teal/orange
 * split tone, and a film-density black lift. Pair with Halation + grain for the
 * full effect.
 */
export const FILM_LOOK_NODE: NodeDef = {
  type: 'film-look',
  label: 'Film Look',
  category: 'FX',
  role: 'effect',
  fx: true,
  accent: '#d97706',
  params: [
    { key: 'intensity', label: 'Intensity', type: 'float', default: 1, min: 0, max: 1, step: 0.01 },
    {
      key: 'contrast',
      label: 'Film Contrast',
      type: 'float',
      default: 0.35,
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      key: 'crosstalk',
      label: 'Color Crosstalk',
      type: 'float',
      default: 0.05,
      min: 0,
      max: 0.2,
      step: 0.005,
    },
    {
      key: 'saturation',
      label: 'Saturation',
      type: 'float',
      default: 0.92,
      min: 0,
      max: 1.5,
      step: 0.01,
    },
    {
      key: 'highlightDesat',
      label: 'Highlight Bleach',
      type: 'float',
      default: 0.4,
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      key: 'splitTone',
      label: 'Split Tone',
      type: 'float',
      default: 0.3,
      min: 0,
      max: 1,
      step: 0.01,
    },
    { key: 'warmth', label: 'Warmth', type: 'float', default: 0.1, min: -1, max: 1, step: 0.01 },
    {
      key: 'blackLift',
      label: 'Black Lift',
      type: 'float',
      default: 0.02,
      min: 0,
      max: 0.1,
      step: 0.002,
    },
  ],
  kernel: {
    body: /* wgsl */ `
      let luma3 = vec3<f32>(0.2126, 0.7152, 0.0722);
      let original = color;
      var c = max(color, vec3<f32>(0.0));

      // 1. dye-coupler crosstalk: bleed a little of each channel into the others
      //    (rows sum to 1, so neutrals stay neutral). Desaturates + couples
      //    channels so the contrast curve can't tear a primary out of gamut.
      let k = P.crosstalk;
      let cm = mat3x3<f32>(
        1.0 - 2.0 * k, k, k,
        k, 1.0 - 2.0 * k, k,
        k, k, 1.0 - 2.0 * k,
      );
      c = cm * c;

      // 2. print-density contrast in log2 space about 0.18 (protects shadows),
      //    then a soft shoulder so highlights roll off instead of clipping.
      let eps = 1e-4;
      let logMid = log2(0.18 + eps);
      c = max(c, vec3<f32>(0.0));
      c = exp2(vec3<f32>(logMid) + (log2(c + vec3<f32>(eps)) - vec3<f32>(logMid)) * (1.0 + P.contrast)) - vec3<f32>(eps);
      c = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
      let sh = c * c * (3.0 - 2.0 * c);
      c = mix(c, sh, 0.25 * P.contrast);

      // 3. overall saturation, then bleach highlights toward neutral.
      var luma = dot(c, luma3);
      c = mix(vec3<f32>(luma), c, P.saturation);
      luma = dot(c, luma3);
      c = mix(c, vec3<f32>(luma), P.highlightDesat * smoothstep(0.55, 1.0, luma));

      // 4. teal shadows / orange highlights split tone + overall warmth.
      let shadowTint = vec3<f32>(-0.05, 0.0, 0.12);
      let highTint = vec3<f32>(0.12, 0.04, -0.06);
      c = c + P.splitTone * mix(shadowTint, highTint, smoothstep(0.0, 1.0, luma));
      c = c + vec3<f32>(P.warmth * 0.08, 0.0, -P.warmth * 0.08);

      // 5. film-density black lift (blacks never reach 0).
      c = c + P.blackLift * (vec3<f32>(1.0) - c);

      color = mix(original, clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), P.intensity);
    `,
  },
}

/**
 * Split Tone — tints shadows and highlights with independent hues, crossing
 * over at a balance point (the classic teal/orange cinematic look). Mirrors
 * Resolve's Split Tone controls (hue + amount per range, plus balance).
 */
export const SPLIT_TONE_NODE: NodeDef = {
  type: 'split-tone',
  label: 'Split Tone',
  category: 'FX',
  role: 'effect',
  fx: true,
  accent: '#14b8a6',
  params: [
    { key: 'amount', label: 'Amount', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01 },
    // Hues are normalized 0..1 (× 360°). Defaults: teal shadows, orange highlights.
    {
      key: 'shadowHue',
      label: 'Shadow Hue',
      type: 'float',
      default: 0.52,
      min: 0,
      max: 1,
      step: 0.005,
    },
    {
      key: 'shadowSat',
      label: 'Shadow Strength',
      type: 'float',
      default: 0.6,
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      key: 'highlightHue',
      label: 'Highlight Hue',
      type: 'float',
      default: 0.08,
      min: 0,
      max: 1,
      step: 0.005,
    },
    {
      key: 'highlightSat',
      label: 'Highlight Strength',
      type: 'float',
      default: 0.6,
      min: 0,
      max: 1,
      step: 0.01,
    },
    { key: 'balance', label: 'Balance', type: 'float', default: 0, min: -1, max: 1, step: 0.01 },
  ],
  kernel: {
    lib: /* wgsl */ `
      // Fully-saturated RGB for a normalized hue (0..1).
      fn grade_hue2rgb(h: f32) -> vec3<f32> {
        let r = clamp(abs(h * 6.0 - 3.0) - 1.0, 0.0, 1.0);
        let g = clamp(2.0 - abs(h * 6.0 - 2.0), 0.0, 1.0);
        let b = clamp(2.0 - abs(h * 6.0 - 4.0), 0.0, 1.0);
        return vec3<f32>(r, g, b);
      }
    `,
    body: /* wgsl */ `
      let luma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
      // Crossover weight: 0 in shadows -> 1 in highlights, shifted by balance.
      let w = smoothstep(0.0, 1.0, clamp(luma + P.balance * 0.5, 0.0, 1.0));
      // Centre each hue around neutral so it pushes toward the hue, not brighter.
      let shadowTint = (grade_hue2rgb(P.shadowHue) - vec3<f32>(0.5)) * P.shadowSat;
      let highTint = (grade_hue2rgb(P.highlightHue) - vec3<f32>(0.5)) * P.highlightSat;
      color = color + mix(shadowTint, highTint, w) * P.amount;
    `,
  },
}

/**
 * LUT — applies a 3D colour lookup table loaded from a `.cube` file (the format
 * Resolve / Adobe / film-emulation packs ship). The actual lattice is uploaded
 * per node instance via `Engine.setNodeLut`; here the kernel just samples it
 * (the compiler injects the `grade_apply_lut` trilinear helper for `lut` nodes)
 * and dials it against the original with `amount`. Inputs are clamped to the
 * 0..1 domain the LUT is defined over.
 */
export const LUT_NODE: NodeDef = {
  type: 'lut',
  label: 'LUT',
  category: 'Color',
  role: 'effect',
  fx: true,
  lut: true,
  accent: '#06b6d4',
  params: [
    { key: 'amount', label: 'Amount', type: 'float', default: 1, min: 0, max: 1, step: 0.01 },
  ],
  kernel: {
    body: /* wgsl */ `
      let graded = grade_apply_lut(color);
      color = mix(color, graded, P.amount);
    `,
  },
}

export const BUILTIN_NODES: NodeDef[] = [
  INPUT_NODE,
  COLOR_SPACE_NODE,
  COLOR_CORRECT_NODE,
  LUT_NODE,
  GLOW_NODE,
  HALATION_NODE,
  SPLIT_TONE_NODE,
  FILM_LOOK_NODE,
  CONTRAST_BRIGHTNESS_NODE,
  OUTPUT_NODE,
]

/** A registry pre-loaded with the built-in node types. */
export function createDefaultRegistry(): NodeRegistry {
  const registry = new NodeRegistry()
  for (const def of BUILTIN_NODES) registry.register(def)
  return registry
}
