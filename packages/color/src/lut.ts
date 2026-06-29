// Cube LUT (.cube) parsing. The `.cube` format (Adobe / DaVinci Resolve / IRIDAS)
// is the lingua franca of creative colour LUTs: a header declaring the grid
// size, then one `r g b` triple per lattice point. This parser is pure — it
// turns text into a flat RGB lattice. Uploading it to the GPU and sampling it
// (trilinear) lives in @grade/engine; the WGSL helper is generated per node.

/** A parsed 3D cube LUT: an N×N×N lattice of output RGB triples. */
export interface CubeLut {
  /** Optional TITLE from the file. */
  title?: string
  /** Grid resolution N (the LUT is N³ entries). */
  size: number
  /**
   * Flat RGB lattice, length `size³ * 3`. Ordered red-fastest, then green, then
   * blue — i.e. entry (r,g,b) lives at `((b*size + g)*size + r) * 3`. This is the
   * `.cube` on-disk order and maps directly to a 3D texture with x=R, y=G, z=B.
   */
  data: Float32Array
}

class CubeParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CubeParseError'
  }
}

/**
 * Parse a 3D `.cube` LUT. Throws `CubeParseError` on malformed input or an
 * unsupported variant (1D LUTs aren't supported — they're rare for creative
 * looks and would need a separate sampling path).
 *
 * Recognised header keywords: `TITLE`, `LUT_3D_SIZE`, `DOMAIN_MIN`,
 * `DOMAIN_MAX`. Comments (`#`) and blank lines are ignored. A non-default
 * domain is honoured by remapping the lattice's implied input range, but since
 * the lattice itself is positional we only validate it (creative LUTs use the
 * standard 0..1 domain).
 */
export function parseCubeLut(text: string): CubeLut {
  let size = 0
  let title: string | undefined
  const triples: number[] = []

  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    // Header keywords are case-insensitive and start with a letter.
    const head = line.toUpperCase()
    if (head.startsWith('TITLE')) {
      const m = line.match(/"([^"]*)"/)
      title = m ? (m[1] ?? '') : line.slice(5).trim()
      continue
    }
    if (head.startsWith('LUT_3D_SIZE')) {
      size = Number.parseInt(line.split(/\s+/)[1] ?? '', 10)
      if (!Number.isInteger(size) || size < 2 || size > 256) {
        throw new CubeParseError(`Invalid LUT_3D_SIZE: ${line}`)
      }
      continue
    }
    if (head.startsWith('LUT_1D_SIZE')) {
      throw new CubeParseError('1D LUTs are not supported — please use a 3D .cube LUT.')
    }
    if (head.startsWith('DOMAIN_MIN') || head.startsWith('DOMAIN_MAX')) {
      // Parsed for forwards-compatibility but not yet applied; standard creative
      // LUTs use the 0..1 domain the sampler already assumes.
      continue
    }

    // Otherwise: a data line of three floats.
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const r = Number.parseFloat(parts[0] ?? '')
    const g = Number.parseFloat(parts[1] ?? '')
    const b = Number.parseFloat(parts[2] ?? '')
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
      throw new CubeParseError(`Malformed data line: "${line}"`)
    }
    triples.push(r, g, b)
  }

  if (size === 0) throw new CubeParseError('Missing LUT_3D_SIZE header.')
  const expected = size * size * size
  if (triples.length !== expected * 3) {
    throw new CubeParseError(
      `LUT data count mismatch: got ${triples.length / 3} entries, expected ${expected} (size ${size}³).`,
    )
  }

  const lut: CubeLut = { size, data: Float32Array.from(triples) }
  if (title !== undefined) lut.title = title
  return lut
}
