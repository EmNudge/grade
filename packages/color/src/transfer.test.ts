import { describe, expect, test } from 'vitest'
import * as fc from 'fast-check'
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
  decodeInputGamma,
  dlogToLinear,
  encodeDisplay,
  gamutFit,
  inputGamutToRec709,
  linearToDlog,
  linearToGamma,
  linearToRec709,
  linearToSrgb,
  logc3ToLinear,
  rec709ToLinear,
  slog3ToLinear,
  srgbToLinear,
  toneMap,
  toneMapFilmic,
  toneMapNone,
  toneMapReinhard,
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
      fc.property(
        fc.double({ min: -10, max: 0, noNaN: true }),
        fc.double({ min: 1.5, max: 3, noNaN: true }),
        (l, g) => {
          expect(linearToGamma(l, g)).toBe(0)
        },
      ),
    )
  })

  test('is monotonic in the input', () => {
    expectMonotonic((l) => linearToGamma(l))
  })
})

describe('sRGB OETF', () => {
  test('round-trips linear -> srgb -> linear across the range', () => {
    fc.assert(
      fc.property(unit(), (v) => {
        expectClose(srgbToLinear(linearToSrgb(v)), v, 1e-5, 1e-5)
      }),
    )
  })

  test('continuity at the piecewise seam (linear 0.0031308 / signal 0.04045)', () => {
    expectClose(12.92 * 0.0031308, 1.055 * Math.pow(0.0031308, 1 / 2.4) - 0.055, 1e-4, 1e-4)
  })

  test('is monotonic and clamps negatives to 0', () => {
    expectMonotonic(linearToSrgb)
    expect(linearToSrgb(-0.5)).toBe(0)
  })
})

describe('tone mapping (scene-linear -> display-linear)', () => {
  const ops = [toneMapFilmic, toneMapReinhard, toneMapNone]

  // The whole point of the fix: every operator anchors middle gray so that after
  // a gamma-2.4 encode it lands at code ~0.40 (a light meter / Resolve), NOT the
  // ~0.50 you get from encoding scene-linear directly.
  test('middle gray (0.18) lands at code ~0.40 under gamma 2.4', () => {
    for (const op of [toneMapFilmic, toneMapReinhard]) {
      expect(encodeDisplay(op(0.18), 'gamma24')).toBeCloseTo(0.4, 2)
    }
  })

  test('encoding scene-linear 0.18 WITHOUT tone mapping is the over-bright bug (~0.49)', () => {
    // Documents why the rendering stage exists: bare gamma 2.4 on scene light
    // puts middle gray at ~0.49 instead of the correct ~0.40 (~1 stop hot).
    expect(encodeDisplay(0.18, 'gamma24')).toBeCloseTo(0.49, 2)
  })

  test('all operators are bounded to [0, 1]', () => {
    fc.assert(
      fc.property(fc.double({ min: -5, max: 1e4, noNaN: true }), (x) => {
        for (const op of ops) {
          expect(op(x)).toBeGreaterThanOrEqual(0)
          expect(op(x)).toBeLessThanOrEqual(1)
        }
      }),
    )
  })

  test('all operators clamp non-positive scene light to 0', () => {
    fc.assert(
      fc.property(fc.double({ min: -5, max: 0, noNaN: true }), (x) => {
        for (const op of ops) expect(op(x)).toBe(0)
      }),
    )
  })

  test('each operator is monotonic over the unit domain', () => {
    for (const op of ops) expectMonotonic(op)
  })

  test('filmic and reinhard roll highlights off below pure clipping', () => {
    // A bright highlight (4x diffuse white) keeps shoulder headroom under a
    // rolloff, whereas "none" has already clipped to 1.
    expect(toneMapFilmic(4)).toBeLessThan(1)
    expect(toneMapReinhard(4)).toBeLessThan(1)
    expect(toneMapNone(4)).toBe(1)
  })
})

describe('gamut fit', () => {
  const rgb = () =>
    fc.tuple(
      fc.double({ min: -2, max: 2, noNaN: true }),
      fc.double({ min: -2, max: 2, noNaN: true }),
      fc.double({ min: -2, max: 2, noNaN: true }),
    ) as fc.Arbitrary<[number, number, number]>

  const luma = (c: readonly [number, number, number]) =>
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

  test('is an exact no-op on in-gamut colors (all channels >= 0)', () => {
    fc.assert(
      fc.property(
        fc.tuple(unit(), unit(), unit()) as fc.Arbitrary<[number, number, number]>,
        (c) => {
          const out = gamutFit(c)
          for (const [i, v] of c.entries()) expect(out[i]).toBe(v)
        },
      ),
    )
  })

  test('lifts negatives up to the luma floor while preserving luma', () => {
    fc.assert(
      fc.property(rgb(), (c) => {
        const out = gamutFit(c)
        // Desaturating toward luma lifts every channel to at least the luma
        // level. For luma >= 0 that means back in gamut; for the rare negative-
        // luma color the final display clamp mops up the remainder.
        expect(Math.min(...out)).toBeGreaterThanOrEqual(Math.min(0, luma(c)) - 1e-9)
        // Desaturating toward luma is luma-preserving by construction.
        expectClose(luma(out), luma(c), 1e-9, 1e-9)
      }),
    )
  })
})

describe('decoupled CST pipeline (Resolve parity)', () => {
  // The full node pipeline, in CPU form: decode input gamma -> input gamut ->
  // gamut map -> tone map -> output gamma.
  function cst(
    signal: [number, number, number],
    inSpace: Parameters<typeof inputGamutToRec709>[1],
    inGamma: Parameters<typeof decodeInputGamma>[1],
    outGamma: Parameters<typeof encodeDisplay>[1],
    tm: Parameters<typeof toneMap>[1] = 'none',
    gm: 'none' | 'fit' = 'none',
  ): [number, number, number] {
    const lin: [number, number, number] = [
      decodeInputGamma(signal[0], inGamma),
      decodeInputGamma(signal[1], inGamma),
      decodeInputGamma(signal[2], inGamma),
    ]
    const rec = inputGamutToRec709(lin, inSpace)
    const mapped = gm === 'fit' ? gamutFit(rec) : rec
    const disp = toneMap(mapped, tm)
    return [
      encodeDisplay(disp[0], outGamma),
      encodeDisplay(disp[1], outGamma),
      encodeDisplay(disp[2], outGamma),
    ]
  }

  // The user's exact Resolve CST: D-Gamut / Gamma 2.4 -> Rec.709 / Gamma 2.4,
  // Tone & Gamut Mapping None. Matching gammas + neutral-preserving matrix means
  // neutrals must pass through untouched — this is what "matches Resolve" means.
  test('D-Gamut/Gamma2.4 -> Rec.709/Gamma2.4 is a neutral passthrough', () => {
    fc.assert(
      fc.property(unit(), (s) => {
        const out = cst([s, s, s], 'dgamut', 'gamma24', 'gamma24')
        for (const ch of out) expectClose(ch, s, 1e-4, 1e-4)
      }),
    )
  })

  test('Rec.709 input gamut is a full identity when gammas match', () => {
    fc.assert(
      fc.property(unit(), unit(), unit(), (r, g, b) => {
        const out = cst([r, g, b], 'rec709', 'gamma24', 'gamma24')
        expectClose(out[0], r, 1e-4, 1e-4)
        expectClose(out[1], g, 1e-4, 1e-4)
        expectClose(out[2], b, 1e-4, 1e-4)
      }),
    )
  })

  // Documents the original bug: decoding footage as D-Log when it's really a
  // Gamma 2.4 signal expands it and reads ~1 stop hot vs the correct passthrough.
  test('decoding a Gamma 2.4 midtone as D-Log over-brightens it', () => {
    const correct = cst([0.4, 0.4, 0.4], 'dgamut', 'gamma24', 'gamma24')[1]
    const asLog = cst([0.4, 0.4, 0.4], 'dgamut', 'dlog', 'gamma24')[1]
    expect(correct).toBeCloseTo(0.4, 2) // passthrough
    expect(asLog).toBeGreaterThan(correct + 0.05) // visibly hotter
  })
})

describe('input gamma decode', () => {
  test('gamma 2.4 decode is the exact inverse of the gamma 2.4 encode', () => {
    fc.assert(
      fc.property(unit(), (v) => {
        expectClose(encodeDisplay(decodeInputGamma(v, 'gamma24'), 'gamma24'), v, 1e-5, 1e-5)
      }),
    )
  })

  test('linear input gamma is a no-op decode', () => {
    fc.assert(
      fc.property(unit(), (v) => {
        expect(decodeInputGamma(v, 'linear')).toBe(v)
      }),
    )
  })

  test('log decodes match their transfer.ts curves (mid gray)', () => {
    expect(decodeInputGamma(420 / 1023, 'slog3')).toBeCloseTo(0.18, 4)
    expect(decodeInputGamma(400 / 1023, 'logc3')).toBeCloseTo(0.18, 3)
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
