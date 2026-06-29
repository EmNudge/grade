// Color gamut conversion matrices.
//
// Source of truth: the official DJI whitepaper "D-Log and D-Gamut of DJI
// Cinema Color System" (Zenmuse X7/X9). D-Gamut primaries (CIE 1931 xy, D65):
//   R (0.71, 0.31)  G (0.21, 0.88)  B (0.09, -0.08)  W (0.3127, 0.3290)
//
// NOTE on D-Log M: DJI publishes no primaries/curve for the *modified* log
// (Osmo Pocket 3, Osmo Action 4/5/6). The D-Gamut math below is the closest
// published transform and is what we use as the analytic approximation; for
// exact D-Log M fidelity, load DJI's official .cube LUT (see lut.ts, planned).

export type Mat3 = readonly [number, number, number, number, number, number, number, number, number]

/** Linear D-Gamut RGB -> linear Rec.709 (BT.709) RGB. */
export const DGAMUT_TO_REC709: Mat3 = [
  1.6746, -0.5797, -0.0949, -0.0981, 1.334, -0.2359, -0.041, -0.243, 1.284,
]

/** Linear Rec.709 RGB -> linear D-Gamut RGB (inverse of the above). */
export const REC709_TO_DGAMUT: Mat3 = [
  0.6163, 0.2857, 0.098, 0.0505, 0.799, 0.1505, 0.0292, 0.1604, 0.8104,
]

// Sony S-Gamut3.Cine -> Rec.709 (D65, no chromatic adaptation; rows sum to 1).
// Composed from S-Gamut3.Cine->XYZ and XYZ->Rec.709. NOTE: this is .Cine, not
// plain S-Gamut3 (which has wider primaries and needs a different matrix).
export const SGAMUT3CINE_TO_REC709: Mat3 = [
  1.62694741, -0.54013854, -0.08680887, -0.17851553, 1.41794093, -0.2394254, -0.04443611,
  -0.19591997, 1.24035608,
]

// ARRI Wide Gamut 3 -> Rec.709, the "Linear Conversion" matrix from ARRI's
// "ALEXA Log C Curve in VFX" doc (correct for scene-linear grading; NOT the
// desaturated tone-mapped variant). AWG3 is ALEXA Classic/Mini/Amira, not AWG4.
export const AWG3_TO_REC709: Mat3 = [
  1.6175234363068, -0.53728662218834, -0.08023681411847, -0.07057274089781, 1.33461306233036,
  -0.26404032143252, -0.02110172804278, -0.22695387521828, 1.24805560326107,
]

/** Identity — used when source and working space already match. */
export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** BT.709 luma coefficients (Rec.709 / sRGB primaries, D65). */
export const REC709_LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722]

/** Multiply a 3x3 matrix by a 3-vector. */
export function applyMat3(m: Mat3, v: readonly [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

/** Emit a Mat3 as a WGSL `mat3x3<f32>` literal (column-major, as WGSL expects). */
export function mat3ToWgsl(m: Mat3): string {
  // Our Mat3 is row-major; WGSL mat3x3 constructor takes columns.
  const col = (c: number) => `vec3<f32>(${m[c]}, ${m[c + 3]}, ${m[c + 6]})`
  return `mat3x3<f32>(${col(0)}, ${col(1)}, ${col(2)})`
}
