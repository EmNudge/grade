// Generates analytic film-emulation .cube LUTs into public/luts/.
//
// These are *creative* Rec.709→Rec.709 looks (they sit downstream of the Color
// Space Transform, like the bundled Presetpro LUTs). Each stock bakes the same
// stages the Film Look node uses — dye-coupler crosstalk, log-space print
// density, saturation + highlight bleach, a split tone, warmth, and a film
// black lift — with per-stock parameters, into a 33³ lattice. Re-run with:
//
//   node apps/web/scripts/gen-film-luts.mjs
//
// Not wired into the build; the .cube outputs are committed under public/luts/.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 33
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'luts')

const clamp01 = (x) => Math.min(1, Math.max(0, x))
const lerp = (a, b, t) => a + (b - a) * t
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b

// Print-density contrast in log2 space about 18% grey, matching FILM_LOOK_NODE.
function filmContrast(c, amount) {
  const eps = 1e-4
  const logMid = Math.log2(0.18 + eps)
  const v = Math.max(c, 0)
  const out = 2 ** (logMid + (Math.log2(v + eps) - logMid) * (1 + amount)) - eps
  return clamp01(out)
}

function applyLook(r0, g0, b0, P) {
  // 1. dye-coupler crosstalk (rows sum to 1, neutrals stay neutral).
  const k = P.crosstalk
  let r = r0 * (1 - 2 * k) + g0 * k + b0 * k
  let g = r0 * k + g0 * (1 - 2 * k) + b0 * k
  let b = r0 * k + g0 * k + b0 * (1 - 2 * k)

  // 2. print-density contrast.
  r = filmContrast(r, P.contrast)
  g = filmContrast(g, P.contrast)
  b = filmContrast(b, P.contrast)

  // 3. saturation, then bleach highlights toward neutral.
  let L = luma(r, g, b)
  r = lerp(L, r, P.sat)
  g = lerp(L, g, P.sat)
  b = lerp(L, b, P.sat)
  L = luma(r, g, b)
  const hb = P.highlightDesat * smoothstep(0.55, 1, L)
  r = lerp(r, L, hb)
  g = lerp(g, L, hb)
  b = lerp(b, L, hb)

  // 4. split tone (shadow→highlight) + overall warmth.
  L = luma(r, g, b)
  const w = smoothstep(0, 1, L)
  r += P.splitTone * lerp(P.shadowTint[0], P.highTint[0], w)
  g += P.splitTone * lerp(P.shadowTint[1], P.highTint[1], w)
  b += P.splitTone * lerp(P.shadowTint[2], P.highTint[2], w)
  r += P.warmth * 0.06
  b -= P.warmth * 0.06

  // 5. monochrome stocks: collapse to luma and apply a toning bias.
  if (P.mono) {
    const m = luma(r, g, b)
    r = m + P.tone[0]
    g = m + P.tone[1]
    b = m + P.tone[2]
  }

  // 6. film black lift (blacks never reach 0).
  r += P.blackLift * (1 - r)
  g += P.blackLift * (1 - g)
  b += P.blackLift * (1 - b)

  return [clamp01(r), clamp01(g), clamp01(b)]
}

const STOCKS = [
  {
    file: 'kodak-2383-print.cube',
    title: 'Kodak 2383 Print',
    P: {
      crosstalk: 0.06,
      contrast: 0.42,
      sat: 1.02,
      highlightDesat: 0.45,
      splitTone: 0.32,
      shadowTint: [-0.05, 0.0, 0.13],
      highTint: [0.13, 0.05, -0.07],
      warmth: 0.12,
      blackLift: 0.015,
      mono: false,
      tone: [0, 0, 0],
    },
  },
  {
    file: 'fuji-3513-print.cube',
    title: 'Fuji 3513 Print',
    P: {
      crosstalk: 0.05,
      contrast: 0.3,
      sat: 0.96,
      highlightDesat: 0.3,
      splitTone: 0.24,
      shadowTint: [-0.04, 0.04, 0.06],
      highTint: [0.04, 0.06, -0.04],
      warmth: -0.04,
      blackLift: 0.025,
      mono: false,
      tone: [0, 0, 0],
    },
  },
  {
    file: 'kodak-vision3-250d.cube',
    title: 'Kodak Vision3 250D',
    P: {
      crosstalk: 0.04,
      contrast: 0.22,
      sat: 1.0,
      highlightDesat: 0.25,
      splitTone: 0.12,
      shadowTint: [-0.02, 0.0, 0.05],
      highTint: [0.05, 0.02, -0.03],
      warmth: 0.06,
      blackLift: 0.02,
      mono: false,
      tone: [0, 0, 0],
    },
  },
  {
    file: 'ilford-hp5-bw.cube',
    title: 'Ilford HP5 Plus B&W',
    P: {
      crosstalk: 0.0,
      contrast: 0.34,
      sat: 1.0,
      highlightDesat: 0.0,
      splitTone: 0.0,
      shadowTint: [0, 0, 0],
      highTint: [0, 0, 0],
      warmth: 0.0,
      blackLift: 0.03,
      mono: true,
      // faint warm-neutral selenium-ish tone.
      tone: [0.012, 0.004, -0.006],
    },
  },
]

function generate(stock) {
  const lines = [`TITLE "${stock.title}"`, `LUT_3D_SIZE ${SIZE}`, '']
  const d = SIZE - 1
  // red-fastest, then green, then blue — the .cube on-disk order.
  for (let bi = 0; bi < SIZE; bi++) {
    for (let gi = 0; gi < SIZE; gi++) {
      for (let ri = 0; ri < SIZE; ri++) {
        const [r, g, b] = applyLook(ri / d, gi / d, bi / d, stock.P)
        lines.push(`${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

mkdirSync(OUT_DIR, { recursive: true })
for (const stock of STOCKS) {
  const path = join(OUT_DIR, stock.file)
  writeFileSync(path, generate(stock))
  console.log(`wrote ${stock.file}`)
}
