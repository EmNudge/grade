// Transfer functions (OETFs and their inverses).
//
// All constants are from the official DJI D-Log/D-Gamut whitepaper and ITU-R
// BT.709. These TS implementations are the CPU reference; the GPU pipeline uses
// the equivalent WGSL in wgsl.ts. Keep the two in lock-step.

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
 * consumer/sRGB-ish displays (~2.2). Most grading pipelines use this for the
 * *look*, not the BT.709 OETF — the gap between them is the "rendering intent".
 */
export function linearToGamma(l: number, gamma = 2.4): number {
  return Math.pow(Math.max(l, 0), 1 / gamma)
}
