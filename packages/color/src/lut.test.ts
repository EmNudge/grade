import { describe, expect, test } from 'vitest'
import { parseCubeLut } from './lut'

// A minimal 2³ identity LUT in .cube form (red-fastest), with comments + title.
const IDENTITY_2 = `# a comment
TITLE "Identity"
LUT_3D_SIZE 2

0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
`

describe('parseCubeLut', () => {
  test('parses size, title, and the full lattice', () => {
    const lut = parseCubeLut(IDENTITY_2)
    expect(lut.size).toBe(2)
    expect(lut.title).toBe('Identity')
    expect(lut.data.length).toBe(2 * 2 * 2 * 3)
    // red-fastest: entry index 1 is (r=1,g=0,b=0).
    expect([lut.data[3], lut.data[4], lut.data[5]]).toEqual([1, 0, 0])
    // last entry is the (1,1,1) corner.
    expect(Array.from(lut.data.slice(-3))).toEqual([1, 1, 1])
  })

  test('tolerates CRLF and DOMAIN_ headers', () => {
    const lut = parseCubeLut(
      'LUT_3D_SIZE 2\r\nDOMAIN_MIN 0 0 0\r\nDOMAIN_MAX 1 1 1\r\n' +
        '0 0 0\r\n1 0 0\r\n0 1 0\r\n1 1 0\r\n0 0 1\r\n1 0 1\r\n0 1 1\r\n1 1 1\r\n',
    )
    expect(lut.size).toBe(2)
    expect(lut.data.length).toBe(24)
  })

  test('rejects a missing size header', () => {
    expect(() => parseCubeLut('0 0 0\n1 1 1\n')).toThrow(/LUT_3D_SIZE/)
  })

  test('rejects a wrong entry count', () => {
    expect(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 0\n1 1 1\n')).toThrow(/mismatch/)
  })

  test('rejects unsupported 1D LUTs', () => {
    expect(() => parseCubeLut('LUT_1D_SIZE 4\n')).toThrow(/1D/)
  })
})
