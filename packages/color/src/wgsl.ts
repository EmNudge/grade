// WGSL building blocks for color transforms.
//
// These are the GPU counterparts of transfer.ts / matrices.ts. Nodes inject
// `COLOR_WGSL_LIB` once and call the helpers from their kernels. Everything
// operates per-channel on linear-or-coded vec3<f32> RGB.

import { AWG3_TO_REC709, DGAMUT_TO_REC709, mat3ToWgsl, SGAMUT3CINE_TO_REC709 } from './matrices'
import type { DisplayEncode, ToneMap } from './transfer'

/**
 * A self-contained WGSL library of color helpers. Inject this near the top of
 * any compute shader that needs color-space work. All functions are pure.
 */
export const COLOR_WGSL_LIB = /* wgsl */ `
// ---- DJI D-Log <-> linear (whitepaper inverse curve) ----
fn grade_dlog_to_linear_c(x: f32) -> f32 {
  if (x <= 0.14) {
    return (x - 0.0929) / 6.025;
  }
  return (pow(10.0, 3.89616 * x - 2.27752) - 0.0108) / 0.9892;
}
fn grade_dlog_to_linear(c: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    grade_dlog_to_linear_c(c.r),
    grade_dlog_to_linear_c(c.g),
    grade_dlog_to_linear_c(c.b),
  );
}

// ---- linear D-Gamut -> linear Rec.709 ----
const GRADE_DGAMUT_TO_REC709: mat3x3<f32> = ${mat3ToWgsl(DGAMUT_TO_REC709)};
fn grade_dgamut_to_rec709(c: vec3<f32>) -> vec3<f32> {
  return GRADE_DGAMUT_TO_REC709 * c;
}

// ---- linear Rec.709 -> display ----
// Standard ITU-R BT.709 OETF.
fn grade_linear_to_rec709_c(l: f32) -> f32 {
  if (l < 0.018) { return 4.5 * l; }
  return 1.099 * pow(l, 0.45) - 0.099;
}
fn grade_linear_to_rec709(c: vec3<f32>) -> vec3<f32> {
  let v = max(c, vec3<f32>(0.0));
  return vec3<f32>(
    grade_linear_to_rec709_c(v.r),
    grade_linear_to_rec709_c(v.g),
    grade_linear_to_rec709_c(v.b),
  );
}
// Pure-gamma display encode (BT.1886 ~2.4 / sRGB-ish ~2.2).
fn grade_linear_to_gamma(c: vec3<f32>, gamma: f32) -> vec3<f32> {
  return pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / gamma));
}
// IEC 61966-2-1 sRGB OETF (piecewise: linear toe + 2.4 power with 1.055 gain).
fn grade_linear_to_srgb_c(l: f32) -> f32 {
  if (l <= 0.0031308) { return 12.92 * l; }
  return 1.055 * pow(l, 1.0 / 2.4) - 0.055;
}
fn grade_linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
  let v = max(c, vec3<f32>(0.0));
  return vec3<f32>(
    grade_linear_to_srgb_c(v.r),
    grade_linear_to_srgb_c(v.g),
    grade_linear_to_srgb_c(v.b),
  );
}

// ---- input gamma decode (coded -> linear), inverse OETFs ----
// Counterparts of the encode curves above, for the Input Gamma control.
fn grade_srgb_to_linear_c(v: f32) -> f32 {
  if (v <= 0.04045) { return v / 12.92; }
  return pow((v + 0.055) / 1.055, 2.4);
}
fn grade_rec709_to_linear_c(v: f32) -> f32 {
  if (v < 0.081) { return v / 4.5; }
  return pow((v + 0.099) / 1.099, 1.0 / 0.45);
}

// BT.709 luma.
fn grade_luma(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// ---- gamut fit ----
// The gamut matrices can push saturated source colors outside Rec.709, producing
// negative channels. Hard-clamping those to 0 inflates saturation and shifts hue.
// Instead, desaturate toward luma by exactly enough to lift the most-negative
// channel back to 0 — this preserves luma and is a no-op on in-gamut colors.
fn grade_gamut_fit(c: vec3<f32>) -> vec3<f32> {
  let m = min(c.r, min(c.g, c.b));
  if (m >= 0.0) { return c; }
  let l = grade_luma(c);
  let t = clamp(m / (m - l), 0.0, 1.0);
  return mix(c, vec3<f32>(l), t);
}

// ---- tone mapping (scene-linear -> display-linear, 0..1) ----
// Maps unbounded scene-linear light into the [0,1] display range with a highlight
// shoulder. All operators are anchored so scene 0.18 (middle gray) -> ~0.111
// display-linear, which lands at code ~0.40 under a gamma-2.4 encode — matching a
// light meter / Resolve's default rendering. Operators run per-channel, so bright
// saturated colors desaturate toward white as they roll off (the "rendering").
//
// Uncharted-2 / Hable filmic curve.
fn grade_hable(x: f32) -> f32 {
  let a = 0.15; let b = 0.50; let c = 0.10; let d = 0.20; let e = 0.02; let f = 0.30;
  return ((x * (a * x + c * b) + d * e) / (x * (a * x + b) + d * f)) - e / f;
}
// mode: 0 none (clip), 1 filmic (Hable), 2 Reinhard.
fn grade_tonemap_c(x: f32, mode: f32) -> f32 {
  let s = max(x, 0.0);
  var out = s;
  if (mode < 0.5) {
    // none: no rolloff, just clip to the display range.
    out = s;
  } else if (mode < 1.5) {
    // filmic: exposure 1.70 + white 11.2 anchor 0.18 -> 0.111 (see doc above).
    out = grade_hable(1.70 * s) / grade_hable(11.2);
  } else {
    let u = 0.69 * s;
    out = u / (1.0 + u);
  }
  return clamp(out, 0.0, 1.0);
}
fn grade_tonemap(c: vec3<f32>, mode: f32) -> vec3<f32> {
  return vec3<f32>(
    grade_tonemap_c(c.r, mode),
    grade_tonemap_c(c.g, mode),
    grade_tonemap_c(c.b, mode),
  );
}

// ---- Sony S-Log3 / S-Gamut3.Cine ----
fn grade_slog3_to_linear_c(x: f32) -> f32 {
  if (x >= 171.2102946929 / 1023.0) {
    return pow(10.0, (x * 1023.0 - 420.0) / 261.5) * (0.18 + 0.01) - 0.01;
  }
  return (x * 1023.0 - 95.0) * 0.01125 / (171.2102946929 - 95.0);
}
fn grade_slog3_to_linear(c: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    grade_slog3_to_linear_c(c.r),
    grade_slog3_to_linear_c(c.g),
    grade_slog3_to_linear_c(c.b),
  );
}
const GRADE_SGAMUT3CINE_TO_REC709: mat3x3<f32> = ${mat3ToWgsl(SGAMUT3CINE_TO_REC709)};
fn grade_sgamut3cine_to_rec709(c: vec3<f32>) -> vec3<f32> {
  return GRADE_SGAMUT3CINE_TO_REC709 * c;
}

// ---- ARRI LogC3 (EI 800) / AWG3 ----
fn grade_logc3_to_linear_c(t: f32) -> f32 {
  let cut = 0.010591; let a = 5.555556; let b = 0.052272;
  let c = 0.24719; let d = 0.385537; let e = 5.367655; let f = 0.092809;
  if (t > e * cut + f) {
    return (pow(10.0, (t - d) / c) - b) / a;
  }
  return (t - f) / e;
}
fn grade_logc3_to_linear(c: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    grade_logc3_to_linear_c(c.r),
    grade_logc3_to_linear_c(c.g),
    grade_logc3_to_linear_c(c.b),
  );
}
const GRADE_AWG3_TO_REC709: mat3x3<f32> = ${mat3ToWgsl(AWG3_TO_REC709)};
fn grade_awg3_to_rec709(c: vec3<f32>) -> vec3<f32> {
  return GRADE_AWG3_TO_REC709 * c;
}

// ---- dispatch helpers (Resolve-style decoupled CST) ----
// The transform is: decode input gamma -> input-gamut matrix -> gamut map ->
// tone map -> encode output gamma. Input gamut and input gamma are INDEPENDENT
// (as in Resolve): e.g. D-Gamut with a Gamma 2.4 transfer is a valid combo and
// is, in fact, a near-passthrough that only rotates the gamut.

// Input Gamma decode (coded -> linear scene/display light).
// gamma: 0 D-Log, 1 S-Log3, 2 LogC3, 3 Gamma 2.4, 4 Gamma 2.2, 5 sRGB,
//        6 BT.709 OETF, 7 Linear.
fn grade_decode_gamma_c(x: f32, gamma: f32) -> f32 {
  if (gamma < 0.5) { return grade_dlog_to_linear_c(x); }
  if (gamma < 1.5) { return grade_slog3_to_linear_c(x); }
  if (gamma < 2.5) { return grade_logc3_to_linear_c(x); }
  if (gamma < 3.5) { return pow(max(x, 0.0), 2.4); }
  if (gamma < 4.5) { return pow(max(x, 0.0), 2.2); }
  if (gamma < 5.5) { return grade_srgb_to_linear_c(x); }
  if (gamma < 6.5) { return grade_rec709_to_linear_c(x); }
  return x;
}
fn grade_decode_gamma(c: vec3<f32>, gamma: f32) -> vec3<f32> {
  return vec3<f32>(
    grade_decode_gamma_c(c.r, gamma),
    grade_decode_gamma_c(c.g, gamma),
    grade_decode_gamma_c(c.b, gamma),
  );
}

// Input Color Space -> linear Rec.709 (gamut rotation only; operates on linear).
// space: 0 D-Gamut, 1 S-Gamut3.Cine, 2 AWG3, 3 Rec.709 (identity).
fn grade_gamut_to_rec709(c: vec3<f32>, space: f32) -> vec3<f32> {
  if (space < 0.5) { return grade_dgamut_to_rec709(c); }
  if (space < 1.5) { return grade_sgamut3cine_to_rec709(c); }
  if (space < 2.5) { return grade_awg3_to_rec709(c); }
  return c;
}

// Gamut Mapping. method: 0 None (let the encode clamp), 1 Fit (desaturate
// out-of-gamut toward luma instead of hard-clamping negatives).
fn grade_gamut_map(c: vec3<f32>, method: f32) -> vec3<f32> {
  if (method < 0.5) { return c; }
  return grade_gamut_fit(c);
}

// Encode display-linear -> code. display: 0 gamma 2.4 (BT.1886), 1 gamma 2.2,
// 2 sRGB, 3 BT.709 OETF.
fn grade_encode_display(lin: vec3<f32>, display: f32) -> vec3<f32> {
  let v = max(lin, vec3<f32>(0.0));
  if (display > 2.5) { return grade_linear_to_rec709(v); }
  if (display > 1.5) { return grade_linear_to_srgb(v); }
  if (display > 0.5) { return grade_linear_to_gamma(v, 2.2); }
  return grade_linear_to_gamma(v, 2.4);
}
`

/** Tone-map operator index, matching the Color Space node's `tonemap` enum. */
const TONEMAP_INDEX: Record<ToneMap, number> = { none: 0, filmic: 1, reinhard: 2 }

/**
 * The full DJI D-Log (M) -> Rec.709 transform as a single WGSL expression on a
 * coded vec3 `c`. Order: decode log -> gamut matrix -> gamut fit -> tone map
 * (scene-linear -> display-linear) -> display encode. `display` picks the output
 * transfer; `tonemap` picks the rendering (defaults to filmic).
 */
export function dlogToRec709Expr(
  c: string,
  display: DisplayEncode = 'gamma24',
  tonemap: ToneMap = 'filmic',
): string {
  const linear = `grade_dgamut_to_rec709(grade_dlog_to_linear(${c}))`
  const rendered = `grade_tonemap(grade_gamut_fit(${linear}), ${TONEMAP_INDEX[tonemap].toFixed(1)})`
  switch (display) {
    case 'bt709':
      return `grade_linear_to_rec709(${rendered})`
    case 'srgb':
      return `grade_linear_to_srgb(${rendered})`
    case 'gamma22':
      return `grade_linear_to_gamma(${rendered}, 2.2)`
    case 'gamma24':
    default:
      return `grade_linear_to_gamma(${rendered}, 2.4)`
  }
}
