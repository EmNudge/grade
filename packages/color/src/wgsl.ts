// WGSL building blocks for color transforms.
//
// These are the GPU counterparts of transfer.ts / matrices.ts. Nodes inject
// `COLOR_WGSL_LIB` once and call the helpers from their kernels. Everything
// operates per-channel on linear-or-coded vec3<f32> RGB.

import { AWG3_TO_REC709, DGAMUT_TO_REC709, mat3ToWgsl, SGAMUT3CINE_TO_REC709 } from './matrices'

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

// BT.709 luma.
fn grade_luma(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
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

// ---- dispatch helpers (source index -> linear Rec.709; display index -> encode) ----
// source: 0 DJI D-Log, 1 Sony S-Log3, 2 ARRI LogC3
fn grade_source_to_rec709_linear(c: vec3<f32>, source: f32) -> vec3<f32> {
  if (source > 1.5) {
    return grade_awg3_to_rec709(grade_logc3_to_linear(c));
  } else if (source > 0.5) {
    return grade_sgamut3cine_to_rec709(grade_slog3_to_linear(c));
  }
  return grade_dgamut_to_rec709(grade_dlog_to_linear(c));
}
// display: 0 gamma 2.4, 1 gamma 2.2, 2 BT.709 OETF
fn grade_encode_display(lin: vec3<f32>, display: f32) -> vec3<f32> {
  let v = max(lin, vec3<f32>(0.0));
  if (display > 1.5) { return grade_linear_to_rec709(v); }
  if (display > 0.5) { return grade_linear_to_gamma(v, 2.2); }
  return grade_linear_to_gamma(v, 2.4);
}
`

/**
 * The full DJI D-Log (M) -> Rec.709 transform as a single WGSL expression on a
 * coded vec3 `c`. Order: decode log -> gamut matrix -> clamp -> display encode.
 * `display` picks the output encode.
 */
export function dlogToRec709Expr(
  c: string,
  display: 'bt709' | 'gamma24' | 'gamma22' = 'gamma24',
): string {
  const linear = `grade_dgamut_to_rec709(grade_dlog_to_linear(${c}))`
  const clamped = `max(${linear}, vec3<f32>(0.0))`
  switch (display) {
    case 'bt709':
      return `grade_linear_to_rec709(${clamped})`
    case 'gamma22':
      return `grade_linear_to_gamma(${clamped}, 2.2)`
    case 'gamma24':
    default:
      return `grade_linear_to_gamma(${clamped}, 2.4)`
  }
}
