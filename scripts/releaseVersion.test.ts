/**
 * The rules of the tag guard, and the one rule the repository itself must obey.
 *
 * `tagVersionProblem` is the whole decision that stands between a pushed tag
 * and a published release, so every rule gets a row here — including the pairs
 * that only differ in the part that matters (v1.0.0 vs v1.0.0-rc.1, tag 1.0.0
 * vs package 0.1.0). The last block reads the REAL package.json: that single
 * assertion turns the `X.Y.0` convention from a paragraph in a checklist into
 * something a wrong version bump cannot get past CI.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PATCH_BASE_VERSION, STABLE_TAG, tagVersionProblem } from './release-version.mjs'

/** The script is plain JS; the casts pin the contract this test relies on. */
const problemOf = tagVersionProblem as (tag: string, version: string) => string | null
const stableTag = STABLE_TAG as RegExp
const patchBase = PATCH_BASE_VERSION as RegExp

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('tags that may be released', () => {
  it.each([
    ['v1.0.0', '1.0.0'],
    ['v1.2.0', '1.2.0'],
    ['v10.20.0', '10.20.0'],
    ['v0.1.0', '0.1.0']
  ])('accepts %s against package version %s', (tag, version) => {
    expect(problemOf(tag, version)).toBeNull()
  })
})

describe('rule 1 — the ref must be a stable vX.Y.Z tag', () => {
  it.each([
    ['v1.0.0-rc.1', 'prerelease suffix on a stable tag'],
    ['v1.0.0-main.1.gabc1234', 'a main-channel version pushed by hand'],
    ['1.0.0', 'missing v prefix'],
    ['v1.0', 'only two components'],
    ['v1.0.0.1', 'four components'],
    ['release-1.0.0', 'not a version tag at all'],
    ['', 'empty ref name']
  ])('rejects %s (%s)', (tag) => {
    const problem = problemOf(tag, '1.0.0')
    expect(problem, tag).toContain('not a stable release tag')
    // The message has to say what a good tag looks like, not just "no".
    expect(problem, tag).toContain('vX.Y.Z')
  })
})

describe('rule 2 — tag and package.json must name the same version', () => {
  it('names both sides and both ways out', () => {
    const problem = problemOf('v1.0.0', '0.1.0')
    expect(problem).toContain('"v1.0.0"')
    expect(problem).toContain('"0.1.0"')
    expect(problem).toContain('bump package.json to 1.0.0')
    expect(problem).toContain('push v0.1.0')
  })

  it.each([
    ['v1.0.0', '0.1.0'],
    ['v2.0.0', '1.0.0'],
    ['v1.1.0', '1.0.0'],
    ['v1.0.0', '1.0.0-main.1.gabc1234']
  ])('rejects tag %s against package version %s', (tag, version) => {
    expect(problemOf(tag, version), `${tag} vs ${version}`).toContain('disagree')
  })

  it('checks the tag shape before the comparison', () => {
    // A prerelease tag whose slice happens to equal the package version must
    // still fail on rule 1 — otherwise `v1.0.0-rc.1` with version `1.0.0-rc.1`
    // would sail through onto the stable channel.
    expect(problemOf('v1.0.0-rc.1', '1.0.0-rc.1')).toContain('not a stable release tag')
  })
})

describe('rule 3 — the package version is a patch BASE, so patch must be 0', () => {
  it.each([
    ['v1.0.1', '1.0.1'],
    ['v0.1.7', '0.1.7'],
    ['v1.0.407', '1.0.407']
  ])('rejects the matching pair %s / %s', (tag, version) => {
    const problem = problemOf(tag, version)
    expect(problem, version).toContain('must have patch 0')
    // The message has to explain the arithmetic, or the next person "fixes"
    // it by bumping the patch.
    expect(problem, version).toContain('ADDING the run number')
  })
})

describe('the regexes themselves', () => {
  it('does not let STABLE_TAG match multi-line input', () => {
    // A regex with `$` but no `^`-anchored line discipline would accept
    // "v1.0.0\nrm -rf" — cheap to assert, expensive to discover later.
    expect(stableTag.test('v1.0.0\nsomething')).toBe(false)
    expect(patchBase.test('1.0.0\nsomething')).toBe(false)
  })
})

describe('this repository', () => {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    version: string
  }

  it('keeps package.json on the X.Y.0 patch base the release arithmetic needs', () => {
    // The convention (docs/RELEASE-CHECKLIST.md → "Versioning"): tag X.Y.0,
    // then immediately open main at X.(Y+1).0. This line is what enforces it.
    expect(pkg.version, `package.json version ${pkg.version}`).toMatch(patchBase)
  })

  it('would release cleanly under its own version tag', () => {
    expect(problemOf(`v${pkg.version}`, pkg.version)).toBeNull()
  })
})
