import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import {
  applyMat3,
  AWG3_TO_REC709,
  DGAMUT_TO_REC709,
  IDENTITY,
  type Mat3,
  REC709_TO_DGAMUT,
  SGAMUT3CINE_TO_REC709,
} from './matrices'
import {
  dlogToLinear,
  linearToDlog,
  linearToGamma,
  linearToRec709,
  logc3ToLinear,
  rec709ToLinear,
  slog3ToLinear,
} from './transfer'

// A code value or scene-linear sample in the working [0, 1] range.
const unit = () => fc.double({ min: 0, max: 1, noNaN: true })

/** Assert `a ≈ b` with combined absolute + relative tolerance (PBT-friendly:
 *  one tolerance that holds for both tiny and large magnitudes). */
function expectClose(a: number, b: number, atol = 1e-4, rtol = 1e-4): void {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(atol + rtol * Math.abs(b))
}

/** A monotonic-nondecreasing law over the unit domain: f(lo) <= f(hi). */
function expectMonotonic(f: (x: number) => number): void {
  fc.assert(
    fc.property(unit(), unit(), (a, b) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      // 1e-9 slack absorbs float noise at the piecewise seams.
      expect(f(lo)).toBeLessThanOrEqual(f(hi) + 1e-9)
    }),
  )
}

describe('DJI D-Log transfer', () => {
  test('round-trips linear -> dlog -> linear across the whole range', () => {
    fc.assert(
      fc.property(unit(), (v) => {
        // The forward constants (0.584555) are a hair off the exact inverse, so
        // round-trip error is ~1e-5 worst case near v=1; 1e-3 is safely above it.
        expectClose(dlogToLinear(linearToDlog(v)), v, 1e-3, 1e-3)
      }),
    )
  })

  test('curve is monotonic across the whole range', () => {
    expectMonotonic(dlogToLinear)
  })
})

describe('Sony S-Log3', () => {
  test('mid gray (code 420/1023) decodes to 0.18', () => {
    expect(slog3ToLinear(420 / 1023)).toBeCloseTo(0.18, 4)
  })

  test('is monotonic across the whole range', () => {
    expectMonotonic(slog3ToLinear)
  })
})

describe('ARRI LogC3 (EI 800)', () => {
  test('18% gray (code ~0.391) decodes to 0.18', () => {
    expect(logc3ToLinear(400 / 1023)).toBeCloseTo(0.18, 3)
  })

  test('is monotonic across the whole range', () => {
    expectMonotonic(logc3ToLinear)
  })
})

describe('BT.709 OETF', () => {
  test('round-trips linear -> rec709 -> linear across the whole range', () => {
    fc.assert(
      fc.property(unit(), (v) => {
        expectClose(rec709ToLinear(linearToRec709(v)), v, 1e-5, 1e-5)
      }),
    )
  })

  test('forward OETF is monotonic, inverse is monotonic', () => {
    expectMonotonic(linearToRec709)
    expectMonotonic(rec709ToLinear)
  })

  test('continuity at the piecewise seam (linear 0.018 / signal 0.081)', () => {
    // The two branches must agree at the threshold or the curve has a step.
    expectClose(4.5 * 0.018, 1.099 * Math.pow(0.018, 0.45) - 0.099, 1e-3, 1e-3)
    expectClose(0.081 / 4.5, Math.pow((0.081 + 0.099) / 1.099, 1 / 0.45), 1e-3, 1e-3)
  })
})

describe('display gamma', () => {
  test('round-trips encode -> decode (pow gamma) across the range', () => {
    fc.assert(
      fc.property(unit(), fc.double({ min: 1.5, max: 3, noNaN: true }), (l, gamma) => {
        expectClose(Math.pow(linearToGamma(l, gamma), gamma), l, 1e-6, 1e-6)
      }),
    )
  })

  test('clamps negative input to 0 (no NaN from fractional powers)', () => {
    fc.assert(
      fc.property(fc.double({ min: -10, max: 0, noNaN: true }), fc.double({ min: 1.5, max: 3, noNaN: true }), (l, g) => {
        expect(linearToGamma(l, g)).toBe(0)
      }),
    )
  })

  test('is monotonic in the input', () => {
    expectMonotonic((l) => linearToGamma(l))
  })
})

describe('gamut matrices', () => {
  // RGB triples, including out-of-[0,1] values the conversion must still handle.
  const rgb = () =>
    fc.tuple(
      fc.double({ min: -2, max: 2, noNaN: true }),
      fc.double({ min: -2, max: 2, noNaN: true }),
      fc.double({ min: -2, max: 2, noNaN: true }),
    ) as fc.Arbitrary<[number, number, number]>

  test('D-Gamut <-> Rec.709 are mutual inverses', () => {
    fc.assert(
      fc.property(rgb(), (c) => {
        const round = applyMat3(REC709_TO_DGAMUT, applyMat3(DGAMUT_TO_REC709, c))
        // Matrices are published to 4 decimals, so the inverse is only ~2-digit.
        for (const [i, expected] of c.entries()) expectClose(round[i]!, expected, 5e-3, 1e-2)
      }),
    )
  })

  test('applyMat3 is linear (additive)', () => {
    fc.assert(
      fc.property(rgb(), rgb(), (a, b) => {
        const sum: [number, number, number] = [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
        const lhs = applyMat3(DGAMUT_TO_REC709, sum)
        const ra = applyMat3(DGAMUT_TO_REC709, a)
        const rb = applyMat3(DGAMUT_TO_REC709, b)
        for (let i = 0; i < 3; i++) expectClose(lhs[i]!, ra[i]! + rb[i]!, 1e-9, 1e-9)
      }),
    )
  })

  test('to-Rec.709 matrices preserve neutrals (rows sum to 1)', () => {
    const toRec709: Mat3[] = [DGAMUT_TO_REC709, SGAMUT3CINE_TO_REC709, AWG3_TO_REC709]
    fc.assert(
      fc.property(fc.double({ min: -1, max: 2, noNaN: true }), (k) => {
        for (const m of toRec709) {
          const out = applyMat3(m, [k, k, k])
          for (const ch of out) expectClose(ch, k, 1e-3, 2e-4)
        }
      }),
    )
  })

  test('identity matrix is an exact no-op', () => {
    fc.assert(
      fc.property(rgb(), (c) => {
        const out = applyMat3(IDENTITY, c)
        // Exact equality, except +0/-0 differ only by IEEE sign after the adds.
        for (const [i, v] of c.entries()) expectClose(out[i]!, v, 0, 0)
      }),
    )
  })
})
