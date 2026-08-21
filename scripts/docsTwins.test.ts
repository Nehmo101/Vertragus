/**
 * The integrity guard for the dual-language documentation.
 *
 * Docs in this repo are English-canonical with maintained German twins: the
 * canonical file is English-named and English-language, and its twin sits
 * beside it as `<NAME>.de.md`. That convention rots silently — a section
 * added to one language and not the other, a link retargeted in the
 * canonical only, German copy pasted into an English file, a twin whose
 * canonical was renamed away. None of that fails a build on its own, so
 * this file checks the FILES:
 *
 *   1. every `.de.md` twin has its canonical, and both open with the
 *      language-switch line pointing at each other.
 *   2. per pair: identical markdown heading tree (count, levels, order) and
 *      identical set of link targets (relative links resolved) — translated
 *      heading TEXT may differ, structure may not.
 *   3. the English canonical of a pair contains no German letters — the
 *      reliable fingerprint of copy that was never translated. Historical
 *      German documents (PLAN-DSH-ADOPTION, RESEARCH-DEEPSEEK-HARNESS) have
 *      no `.de.md` twin, so pair discovery never touches them.
 *   4. globally: every relative link in every markdown file resolves to a
 *      file on disk, and every `docs/<name>.md` path mentioned in `src/**`
 *      and `scripts/**` sources exists.
 *
 * Self-checks at the bottom keep the scanners honest: a regex that silently
 * stops matching must fail the suite, not green it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  'out',
  'dist',
  'release',
  'coverage',
  '.vertragus'
])

/** Recursively list files below `dir` (repo-relative, posix separators). */
function walk(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      return IGNORED_DIRS.has(entry.name) ? [] : walk(rel, keep)
    }
    if (!entry.isFile() || !keep(entry.name)) return []
    return [rel]
  })
}

const markdownFiles = walk('.', (name) => name.endsWith('.md'))

/** Twin pairs discovered by the `.de.md` convention. */
const twins = markdownFiles
  .filter((file) => file.endsWith('.de.md'))
  .map((twin) => ({ twin, canonical: twin.replace(/\.de\.md$/, '.md') }))

interface ParsedDoc {
  /** `##` etc. levels in document order, fenced code excluded. */
  headings: number[]
  /** Link targets, relative ones resolved repo-relative; switch line excluded. */
  linkTargets: string[]
  /** Like linkTargets, but including the switch line's own link. */
  allLinkTargets: string[]
  firstLine: string
}

const SWITCH_LINE = /^(English \| \[Deutsch\]\([^)]+\.de\.md\)|Deutsch \| \[English\]\([^)]+\.md\))\s*$/
const LINK = /\]\(([^()\s]+)\)/g
const GERMAN_LETTERS = /[äöüÄÖÜß]/

function parseDoc(file: string): ParsedDoc {
  const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n')
  const headings: number[] = []
  const linkTargets: string[] = []
  const allLinkTargets: string[] = []
  let inFence = false
  for (const [index, line] of lines.entries()) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const heading = /^(#{1,6})\s/.exec(line)
    if (heading) headings.push(heading[1]!.length)
    const isSwitchLine = index === 0 && SWITCH_LINE.test(line)
    for (const match of line.matchAll(LINK)) {
      const target = match[1]!.replace(/#.*$/, '')
      if (target === '') continue
      const resolved = /^[a-z][a-z0-9+.-]*:/i.test(target)
        ? match[1]!
        : relative(repoRoot, resolve(repoRoot, dirname(file), target)).split(sep).join('/')
      allLinkTargets.push(resolved)
      if (!isSwitchLine) linkTargets.push(resolved)
    }
  }
  return { headings, linkTargets, allLinkTargets, firstLine: lines[0] ?? '' }
}

/**
 * Canonicals allowed to carry German letters. EMPTY and meant to stay that
 * way — an entry would be a temporary concession, and the honesty check
 * below deletes any entry that is no longer needed, so the list can only
 * shrink.
 */
const GERMAN_ALLOWLIST = new Set<string>([])

describe('twin discovery', () => {
  it('finds the pairs it is supposed to police', () => {
    // If discovery broke, every per-pair check below would pass vacuously.
    expect(twins.length).toBeGreaterThanOrEqual(5)
    const names = twins.map((pair) => pair.canonical)
    expect(names).toContain('README.md')
    expect(names).toContain('docs/HANDBOOK-HARNESS.md')
  })

  it('leaves no orphan twin without a canonical', () => {
    const orphans = twins.filter((pair) => !existsSync(join(repoRoot, pair.canonical)))
    expect(orphans.map((pair) => pair.twin)).toEqual([])
  })
})

describe.each(twins)('twin pair $canonical ↔ $twin', ({ canonical, twin }) => {
  const en = parseDoc(canonical)
  const de = parseDoc(twin)

  it('starts both files with the language-switch line', () => {
    expect(en.firstLine, canonical).toMatch(SWITCH_LINE)
    expect(en.firstLine, canonical).toContain(`](${basename(twin)})`)
    expect(de.firstLine, twin).toMatch(SWITCH_LINE)
    expect(de.firstLine, twin).toContain(`](${basename(canonical)})`)
  })

  it('keeps the heading tree identical (count, levels, order)', () => {
    expect(de.headings, `${twin} vs ${canonical}`).toEqual(en.headings)
    // A parser that saw no headings at all would "match" trivially.
    expect(en.headings.length, canonical).toBeGreaterThan(0)
  })

  it('links to the same set of targets', () => {
    const sorted = (targets: string[]): string[] => [...new Set(targets)].sort()
    expect(sorted(de.linkTargets), `${twin} vs ${canonical}`).toEqual(sorted(en.linkTargets))
  })

  it('keeps the English canonical actually English', () => {
    if (GERMAN_ALLOWLIST.has(canonical)) return
    const source = readFileSync(join(repoRoot, canonical), 'utf8')
    const offenders = source
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line, number }) => number > 1 && GERMAN_LETTERS.test(line))
    expect(
      offenders.map(({ number, line }) => `${canonical}:${number}: ${line.trim()}`),
      `German copy in ${canonical}`
    ).toEqual([])
  })
})

describe('the German allowlist', () => {
  it('can only shrink', () => {
    const stale = [...GERMAN_ALLOWLIST].filter((file) => {
      if (!existsSync(join(repoRoot, file))) return true
      return !GERMAN_LETTERS.test(readFileSync(join(repoRoot, file), 'utf8'))
    })
    expect(stale, `Already clean — drop from GERMAN_ALLOWLIST: ${stale.join(', ')}`).toEqual([])
  })
})

describe('every markdown link resolves', () => {
  const checked: { file: string; target: string }[] = []
  const broken: string[] = []
  for (const file of markdownFiles) {
    for (const target of parseDoc(file).allLinkTargets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
      checked.push({ file, target })
      if (!existsSync(join(repoRoot, target))) broken.push(`${file} → ${target}`)
    }
  }

  it('checks a meaningful number of links', () => {
    expect(checked.length).toBeGreaterThanOrEqual(40)
    expect(new Set(checked.map((entry) => entry.file)).size).toBeGreaterThanOrEqual(10)
  })

  it('finds no dead relative link', () => {
    expect(broken).toEqual([])
  })
})

describe('doc paths mentioned in source code', () => {
  const selfName = 'scripts/docsTwins.test.ts'
  const sourceFiles = ['src', 'scripts', 'tests'].flatMap((dir) =>
    walk(dir, (name) => /\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith('.d.ts'))
  )
  const DOC_REF = /docs\/[A-Za-z0-9._-]+\.md/g
  const refs: { file: string; ref: string }[] = []
  for (const file of sourceFiles) {
    if (file === selfName) continue
    const source = readFileSync(join(repoRoot, file), 'utf8')
    for (const match of source.matchAll(DOC_REF)) {
      refs.push({ file, ref: match[0] })
    }
  }

  it('scans a meaningful number of source files', () => {
    // The doc-reference count may legitimately be zero; the scan itself must
    // never quietly cover nothing.
    expect(sourceFiles.length).toBeGreaterThan(100)
    expect(sourceFiles).toContain('src/main/providers/presets.ts')
    expect(sourceFiles).toContain('scripts/gen-icons.mjs')
  })

  it('references only docs that exist', () => {
    const dead = refs.filter(({ ref }) => !existsSync(join(repoRoot, ref)))
    expect(dead.map(({ file, ref }) => `${file} → ${ref}`)).toEqual([])
  })
})
