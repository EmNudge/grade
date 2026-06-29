import { parseCubeLut } from '@grade/color'
import type { LoadedLut } from './store'

/**
 * Built-in creative LUTs, shipped as static `.cube` assets under
 * `public/luts/`. They're fetched + parsed on demand (only when picked), so
 * they stay out of the JS bundle. These are Rec.709 creative looks (Presetpro),
 * which match the Rec.709 signal a corrector produces downstream of the Color
 * Space Transform.
 */
export interface BuiltinLut {
  id: string
  name: string
  /** File name under `public/luts/`. */
  file: string
}

export const BUILTIN_LUTS: BuiltinLut[] = [
  { id: 'bold-film', name: 'Bold Film', file: 'bold-film.cube' },
  { id: 'brooklyn', name: 'Brooklyn', file: 'brooklyn.cube' },
  { id: 'kodachrome-64', name: 'Kodachrome 64', file: 'kodachrome-64.cube' },
  { id: 'lomography', name: 'Lomography', file: 'lomography.cube' },
]

/** Fetch + parse a built-in LUT into the form the engine consumes. */
export async function loadBuiltinLut(lut: BuiltinLut): Promise<LoadedLut> {
  const res = await fetch(`${import.meta.env.BASE_URL}luts/${lut.file}`)
  if (!res.ok) throw new Error(`Failed to fetch "${lut.name}" (${res.status})`)
  const parsed = parseCubeLut(await res.text())
  return { name: lut.name, size: parsed.size, data: parsed.data }
}
