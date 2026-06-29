import { describe, expect, test } from 'vitest'
import { CHROMA_PT_MAX, COLOR_CORRECT_NODE, createDefaultRegistry } from './builtin'
import { defaultValues } from './registry'

describe('node registry', () => {
  const reg = createDefaultRegistry()

  test('registers the core node types', () => {
    for (const t of [
      'input',
      'output',
      'color-correct',
      'color-space',
      'glow',
      'halation',
      'film-look',
      'split-tone',
    ]) {
      expect(reg.get(t)).toBeDefined()
    }
  })

  test('registers the mononodes-style DCTL FX', () => {
    for (const t of [
      'rgb-crosstalk',
      'color-shift',
      'color-shaper',
      'hue-twist',
      'rgb-split-tone',
      'lab-adjust',
      'clamp',
      'middle-gray',
      'clipping',
      'isolator',
      'grid',
      'test-ramp',
      'test-strip',
      'stretch',
      'border',
    ]) {
      const def = reg.get(t)
      expect(def).toBeDefined()
      expect(def?.fx).toBe(true)
      expect(def?.kernel?.body).toBeTruthy()
    }
  })

  test('FX defs are flagged fx:true; the base corrector is not', () => {
    expect(reg.require('glow').fx).toBe(true)
    expect(reg.require('color-space').fx).toBe(true)
    expect(reg.require('halation').fx).toBe(true)
    expect(reg.require('color-correct').fx).toBeUndefined()
  })

  test('corrector default values cover every param key', () => {
    const v = defaultValues(COLOR_CORRECT_NODE)
    for (const p of COLOR_CORRECT_NODE.params) {
      expect(v[p.key]).toBeDefined()
    }
  })

  test('chroma-warp stroke params exist for every slot', () => {
    const keys = new Set(COLOR_CORRECT_NODE.params.map((p) => p.key))
    expect(keys.has('cw_n')).toBe(true)
    expect(keys.has('cw_tlo')).toBe(true)
    expect(keys.has('cw_thi')).toBe(true)
    expect(keys.has('cw_tpv')).toBe(true)
    for (let i = 0; i < CHROMA_PT_MAX; i++) {
      for (const f of ['sx', 'sy', 'tx', 'ty', 'r', 'e']) {
        expect(keys.has(`cw_${f}${i}`)).toBe(true)
      }
    }
  })
})
