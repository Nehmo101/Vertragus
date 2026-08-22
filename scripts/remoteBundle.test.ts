/**
 * Size and content guard for the phone client's shipped bundle.
 *
 * The client is loaded over a tailnet, often on cellular, on a device the user
 * is holding while a run is live. What lands in its entry chunk is a product
 * decision, and it has already been made badly once: a single value import of
 * one integer from the module that declares the wire schemas pulled zod — a
 * validator the client never runs — into the entry chunk, 57 kB raw and 13 kB
 * gzipped, and passed every typecheck, every lint and all 2350 tests.
 *
 * The lint rule added afterwards bans that import, but a rule can only ban the
 * routes someone thought of: the same module by a relative path, or any of the
 * seven other zod-bearing modules the client can already resolve, walks past
 * it. So this asserts the thing the invariant is actually about — the bytes on
 * the wire — the same way `staticFiles.test.ts` asserts against the page the
 * server really serves rather than the one in the source tree.
 *
 * It runs whenever a build exists. `pnpm run ci` builds before
 * `test:coverage`, so CI executes it; a fresh checkout with no `out/` skips it
 * rather than failing, and says so.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

const assetsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../out/remote/assets')
const built = existsSync(assetsDir)

function chunk(prefix: string): { name: string; code: string } {
  const name = readdirSync(assetsDir).find(
    (entry) => entry.startsWith(prefix) && entry.endsWith('.js')
  )
  if (name === undefined) throw new Error(`self-check: no ${prefix}*.js in ${assetsDir}`)
  return { name, code: readFileSync(join(assetsDir, name), 'utf8') }
}

const gzippedKb = (code: string): number => gzipSync(Buffer.from(code)).length / 1024

/**
 * Strings zod emits into any bundle that contains it, chosen to survive
 * minification: they are string literals in error construction, not identifiers
 * a minifier may rename.
 */
const ZOD_FINGERPRINTS = ['invalid_union', 'invalid_literal', 'unrecognized_keys', 'ZodError']

/**
 * The entry chunk's gzipped budget, in kB. Measured at 65.2 with the terminal
 * split out; the headroom is for ordinary growth, not for a dependency. Raise
 * it deliberately, the way the coverage ratchet is raised, and say what the
 * bytes bought.
 */
const ENTRY_GZIP_BUDGET_KB = 72

describe.skipIf(!built)('the phone bundle', () => {
  it('is looking at a real build', () => {
    // Self-check: every assertion below is about these two chunks, and a
    // renamed output would otherwise green the whole describe vacuously.
    expect(chunk('index-').code.length).toBeGreaterThan(10_000)
    expect(chunk('RemoteTerminal-').code.length).toBeGreaterThan(10_000)
  })

  it('carries no schema validator, in any chunk', () => {
    // The client validates nothing: the host is the trust anchor and the
    // gateway does the checking. zod here is pure weight, and the fingerprints
    // are what makes this catch a route nobody predicted.
    //
    // EVERY emitted chunk, not the two named ones: a dynamic import lands in a
    // chunk of its own, so checking only the entry and the terminal would let
    // `await import('@shared/remote/protocol')` ship zod to a phone unseen —
    // and lazy chunks are an established pattern in this client.
    const chunks = readdirSync(assetsDir).filter((entry) => entry.endsWith('.js'))
    expect(chunks.length, 'self-check: no chunks to scan').toBeGreaterThanOrEqual(2)
    for (const name of chunks) {
      const code = readFileSync(join(assetsDir, name), 'utf8')
      for (const fingerprint of ZOD_FINGERPRINTS) {
        expect(code.includes(fingerprint), `${name} contains zod (${fingerprint})`).toBe(false)
      }
    }
  })

  it('keeps the cold path inside its budget', () => {
    const { name, code } = chunk('index-')
    const kb = gzippedKb(code)
    expect(kb, `${name} is ${kb.toFixed(1)} kB gzipped`).toBeLessThan(ENTRY_GZIP_BUDGET_KB)
  })

  it('still loads the terminal on demand rather than up front', () => {
    // The split is what makes the budget above achievable: the overview is the
    // landing screen and xterm is a deliberate tap. A regression that inlined
    // it would blow the budget, but it would blow it for a reason worth naming
    // separately from a stray dependency.
    const terminal = chunk('RemoteTerminal-')
    expect(gzippedKb(terminal.code)).toBeGreaterThan(20)
    expect(chunk('index-').code).not.toContain('xterm.js')
  })
})

describe.skipIf(built)('the phone bundle guard', () => {
  it('is skipped without a build, and says so', () => {
    // Not a silent pass: `pnpm run build:remote` makes the assertions above run.
    expect(built).toBe(false)
  })
})
