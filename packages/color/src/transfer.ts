// Transfer functions (OETFs and their inverses).
//
// All constants are from the official DJI D-Log/D-Gamut whitepaper and ITU-R
// BT.709. These TS implementations are the CPU reference; the GPU pipeline uses
// the equivalent WGSL in wgsl.ts. Keep the two in lock-step.

import {
  applyMat3,
  AWG3_TO_REC709,
  DGAMUT_TO_REC709,
  REC709_LUMA,
  SGAMUT3CINE_TO_REC709,
} from './matrices'

/**
 * DJI D-Log code value (0..1) -> linear scene light.
 *
 * Official inverse curve (whitepaper):
 *   x <= 0.14:  (x - 0.0929) / 6.025
 *   else:       (10^(3.89616*x - 2.27752) - 0.0108) / 0.9892
 */
export function dlogToLinear(x: number): number {
  if (x <= 0.14) return (x - 0.0929) / 6.025
  return (Math.pow(10, 3.89616 * x - 2.27752) - 0.0108) / 0.9892
}

/** Linear scene light -> DJI D-Log code value (forward OETF). */
export function linearToDlog(v: number): number {
  if (v <= 0.0078) return 6.025 * v + 0.0929
  return Math.log10(v * 0.9892 + 0.0108) * 0.256663 + 0.584555
}

/**
 * Sony S-Log3 code value (0..1, = 10-bit/1023) -> scene-linear (0.18 = mid gray).
 * Official Sony technical-summary formula.
 */
export function slog3ToLinear(x: number): number {
  if (x >= 171.2102946929 / 1023) return 10 ** ((x * 1023 - 420) / 261.5) * (0.18 + 0.01) - 0.01
  return ((x * 1023 - 95) * 0.01125) / (171.2102946929 - 95)
}

/**
 * ARRI LogC3 code value (0..1) -> scene-linear, EI 800 (exposure-value set,
 * the correct one for scene-linear/VFX). From ARRI's "Log C Curve in VFX" doc.
 */
export function logc3ToLinear(t: number): number {
  // EI 800 constants
  const cut = 0.010591,
    a = 5.555556,
    b = 0.052272,
    c = 0.24719,
    d = 0.385537,
    e = 5.367655,
    f = 0.092809
  if (t > e * cut + f) return (10 ** ((t - d) / c) - b) / a
  return (t - f) / e
}

/**
 * Linear BT.709 -> display signal, standard ITU-R BT.709 OETF.
 *   L < 0.018:  4.5 * L
 *   else:       1.099 * L^0.45 - 0.099
 */
export function linearToRec709(l: number): number {
  if (l < 0.018) return 4.5 * l
  return 1.099 * Math.pow(l, 0.45) - 0.099
}

/** BT.709 display signal -> linear (inverse OETF). */
export function rec709ToLinear(v: number): number {
  if (v < 0.081) return v / 4.5
  return Math.pow((v + 0.099) / 1.099, 1 / 0.45)
}

/**
 * Pure-gamma display encode, as used by reference monitors (BT.1886, ~2.4) and
 * consumer/sRGB-ish displays (~2.2). This is a *display EOTF inverse* — feed it
 * tone-mapped display-linear, not raw scene light (a bare power on scene light
 * puts middle gray ~1 stop too bright; that gap is the missing rendering).
 */
export function linearToGamma(l: number, gamma = 2.4): number {
  return Math.pow(Math.max(l, 0), 1 / gamma)
}

/** Display-linear -> sRGB code (IEC 61966-2-1 OETF). */
export function linearToSrgb(l: number): number {
  const v = Math.max(l, 0)
  if (v <= 0.0031308) return 12.92 * v
  return 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/** sRGB code -> display-linear (inverse OETF). */
export function srgbToLinear(v: number): number {
  if (v <= 0.04045) return v / 12.92
  return Math.pow((v + 0.055) / 1.055, 2.4)
}

// ---- rendering: scene-linear -> display-linear ----
//
// The decode/gamut stages produce *scene-referred* linear light (0.18 = middle
// gray, highlights unbounded). A display can only show [0, 1], so a rendering
// transform is required before the display encode. Without it, scene gray hits
// code ~0.50 under gamma 2.4 (over-exposed) and highlights never roll off
// (over-saturated). Every operator below is anchored so 0.18 -> ~0.111
// display-linear == code ~0.40 under gamma 2.4, matching a light meter / Resolve.

/** Uncharted-2 / Hable filmic helper. */
function hable(x: number): number {
  const a = 0.15,
    b = 0.5,
    c = 0.1,
    d = 0.2,
    e = 0.02,
    f = 0.3
  return (x * (a * x + c * b) + d * e) / (x * (a * x + b) + d * f) - e / f
}

/** Filmic (Hable) tone map. Exposure 1.70 + white 11.2 anchor 0.18 -> ~0.111. */
export function toneMapFilmic(x: number): number {
  const out = hable(1.7 * Math.max(x, 0)) / hable(11.2)
  return Math.min(Math.max(out, 0), 1)
}

/** Reinhard tone map, exposure-anchored so 0.18 -> ~0.111. Soft, never clips. */
export function toneMapReinhard(x: number): number {
  const u = 0.69 * Math.max(x, 0)
  return u / (1 + u)
}

/** No rendering — clip scene-linear to [0, 1]. Honest, but blows out highlights. */
export function toneMapNone(x: number): number {
  return Math.min(Math.max(x, 0), 1)
}

/** Tone-mapping operators the rendering stage can apply. */
export type ToneMap = 'filmic' | 'reinhard' | 'none'

/** Apply a tone-map operator per channel (scene-linear -> display-linear). */
export function toneMap(
  rgb: readonly [number, number, number],
  mode: ToneMap,
): [number, number, number] {
  const f = mode === 'filmic' ? toneMapFilmic : mode === 'reinhard' ? toneMapReinhard : toneMapNone
  return [f(rgb[0]), f(rgb[1]), f(rgb[2])]
}

/**
 * Desaturate an out-of-gamut color toward its luma by just enough to lift the
 * most-negative channel to 0. Luma-preserving, and a no-op on in-gamut colors —
 * the analytic counterpart to hard-clamping negatives (which inflates saturation).
 */
export function gamutFit(rgb: readonly [number, number, number]): [number, number, number] {
  const m = Math.min(rgb[0], rgb[1], rgb[2])
  if (m >= 0) return [rgb[0], rgb[1], rgb[2]]
  const l = REC709_LUMA[0] * rgb[0] + REC709_LUMA[1] * rgb[1] + REC709_LUMA[2] * rgb[2]
  const t = Math.min(Math.max(m / (m - l), 0), 1)
  return [rgb[0] + (l - rgb[0]) * t, rgb[1] + (l - rgb[1]) * t, rgb[2] + (l - rgb[2]) * t]
}

/** Input transfer functions the decode stage understands (Resolve "Input Gamma"). */
export type InputGamma =
  | 'dlog' // DJI D-Log
  | 'slog3' // Sony S-Log3
  | 'logc3' // ARRI LogC3 (EI 800)
  | 'gamma24' // pure 2.4 power (the DI / Resolve "Gamma 2.4")
  | 'gamma22' // pure 2.2 power
  | 'srgb' // sRGB EOTF
  | 'bt709' // BT.709 OETF inverse
  | 'linear' // already scene-linear

/** Decode a coded value to linear for the chosen input gamma (inverse transfer). */
export function decodeInputGamma(x: number, gamma: InputGamma): number {
  switch (gamma) {
    case 'dlog':
      return dlogToLinear(x)
    case 'slog3':
      return slog3ToLinear(x)
    case 'logc3':
      return logc3ToLinear(x)
    case 'gamma24':
      return Math.pow(Math.max(x, 0), 2.4)
    case 'gamma22':
      return Math.pow(Math.max(x, 0), 2.2)
    case 'srgb':
      return srgbToLinear(x)
    case 'bt709':
      return rec709ToLinear(x)
    default:
      return x
  }
}

/** Input gamuts the matrix stage can rotate into Rec.709 (Resolve "Input Color Space"). */
export type InputColorSpace = 'dgamut' | 'sgamut3cine' | 'awg3' | 'rec709'

/** Rotate a linear color from the input gamut into linear Rec.709 primaries. */
export function inputGamutToRec709(
  rgb: readonly [number, number, number],
  space: InputColorSpace,
): [number, number, number] {
  switch (space) {
    case 'dgamut':
      return applyMat3(DGAMUT_TO_REC709, rgb)
    case 'sgamut3cine':
      return applyMat3(SGAMUT3CINE_TO_REC709, rgb)
    case 'awg3':
      return applyMat3(AWG3_TO_REC709, rgb)
    default:
      return [rgb[0], rgb[1], rgb[2]]
  }
}

/** Display encodings the output transform can target (display EOTF inverse). */
export type DisplayEncode = 'gamma24' | 'gamma22' | 'srgb' | 'bt709'

/** Encode display-linear -> code for the chosen display transfer. */
export function encodeDisplay(l: number, display: DisplayEncode): number {
  switch (display) {
    case 'bt709':
      return linearToRec709(Math.max(l, 0))
    case 'srgb':
      return linearToSrgb(l)
    case 'gamma22':
      return linearToGamma(l, 2.2)
    default:
      return linearToGamma(l, 2.4)
  }
}
