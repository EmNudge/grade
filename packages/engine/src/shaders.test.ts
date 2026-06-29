// Validate every node's *generated* WGSL with naga (the validator wgpu and
// Firefox use). Our shaders aren't static files — `generateWgsl` assembles each
// one from a node's kernel plus a Params struct built from its param keys — so
// the only way to catch invalid WGSL (reserved keywords, type errors, bad
// bindings) at build time is to generate each shader and validate the output.
//
// naga is invoked via the CLI. Install it with `cargo install naga-cli`. When
// it isn't present the validation cases skip (with a warning) so local runs
// without the Rust toolchain aren't blocked; CI installs it and enforces them.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { BUILTIN_NODES } from '@grade/nodes'
import { generateWgsl } from './compile'

const hasNaga = spawnSync('naga', ['--version']).status === 0
if (!hasNaga) {
  console.warn(
    '[shaders.test] naga not on PATH — skipping WGSL validation. Install with `cargo install naga-cli`.',
  )
}

const shaderNodes = BUILTIN_NODES.filter((def) => def.kernel)

test('there is at least one shader node to validate', () => {
  expect(shaderNodes.length).toBeGreaterThan(0)
})

for (const def of shaderNodes) {
  test.skipIf(!hasNaga)(`WGSL for "${def.type}" is valid`, () => {
    const wgsl = generateWgsl(def)
    const dir = mkdtempSync(join(tmpdir(), 'grade-wgsl-'))
    const input = join(dir, `${def.type}.wgsl`)
    const output = join(dir, `${def.type}.out.wgsl`)
    writeFileSync(input, wgsl)
    try {
      // Round-trip through naga: it parses + fully validates, and only writes
      // the output on success — so a non-zero exit means the shader is invalid.
      execFileSync('naga', [input, output], { stdio: 'pipe' })
    } catch (err) {
      const e = err as { stderr?: Buffer; stdout?: Buffer }
      const diagnostics = `${e.stderr?.toString() ?? ''}${e.stdout?.toString() ?? ''}`.trim()
      throw new Error(
        `naga rejected the "${def.type}" shader:\n\n${diagnostics}\n\n--- WGSL ---\n${wgsl}`,
        { cause: err },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
