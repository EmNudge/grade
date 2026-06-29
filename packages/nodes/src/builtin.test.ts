import { describe, expect, test } from 'bun:test'
import { CHROMA_HUES, COLOR_CORRECT_NODE, createDefaultRegistry } from './builtin'
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

  test('chroma-warp params exist for every hue sector', () => {
    const keys = new Set(COLOR_CORRECT_NODE.params.map((p) => p.key))
    for (const h of CHROMA_HUES) {
      expect(keys.has(`cw_h_${h.key}`)).toBe(true)
      expect(keys.has(`cw_s_${h.key}`)).toBe(true)
    }
  })
})
