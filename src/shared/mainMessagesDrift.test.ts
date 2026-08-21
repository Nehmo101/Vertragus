/**
 * The inverse drift guard for `mainMessages.ts`.
 *
 * `mainMessages.test.ts` pins that the table speaks both languages; this file
 * pins that the table stays the ONLY place main-process German lives. A German
 * string literal typed directly into `src/main/**` bypasses the locale switch
 * and reappears untranslated in the English UI — exactly the class of bug
 * WP-1 closed. So every non-test main source is tokenized (comments stripped,
 * string literals extracted) and any literal carrying an umlaut or eszett
 * fails the build with its file named.
 *
 * German COMMENTS are deliberately fine — they are for developers, not users
 * — which is why this cannot be a grep: it must tell strings from comments.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const mainSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'main')

/** The reliable fingerprint of German copy. */
const GERMAN_LETTERS = /[äöüÄÖÜß]/

/** Every non-test `.ts` under `src/main/**`. */
function mainSources(dir = mainSrc): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return mainSources(full)
    if (!entry.isFile()) return []
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) return []
    if (entry.name.endsWith('.test.ts')) return []
    return [relative(mainSrc, full).split(sep).join('/')]
  })
}

/**
 * Extract the string literals of a TypeScript source, skipping line and
 * block comments. A character walk instead of a regex: a regex cannot tell
 * a quote inside a comment from a real literal, and a guard with false
 * positives gets deleted, not fixed. Template-literal interpolations stay part
 * of the captured text — German inside `${'…'}` is still German on screen.
 */
function stringLiterals(source: string): string[] {
  const found: string[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]!
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let literal = ''
      i += 1
      while (i < source.length) {
        const c = source[i]!
        if (c === '\\') {
          literal += source.slice(i, i + 2)
          i += 2
          continue
        }
        if (c === ch) {
          i += 1
          break
        }
        literal += c
        i += 1
      }
      found.push(literal)
      continue
    }
    i += 1
  }
  return found
}

describe('no German string literals outside mainMessages', () => {
  const files = mainSources()

  it('actually scans the main process — an empty walk would pass for free', () => {
    expect(files.length).toBeGreaterThan(10)
    expect(files).toContain('updater.ts')
  })

  it('tells strings from comments — the tokenizer itself is under test', () => {
    const sample = [
      "// Kommentar mit Umlaut: schön",
      "/* Blöcke zählen auch nicht */",
      "const ok = 'plain english'",
      "const bad = `Vorlage mit Größe ${x}`"
    ].join('\n')
    const literals = stringLiterals(sample)
    expect(literals).toContain('plain english')
    expect(literals.filter((literal) => GERMAN_LETTERS.test(literal))).toHaveLength(1)
  })

  it('finds no German literal in src/main/** — new copy goes through mainMessages', () => {
    const offenders = files.flatMap((file) => {
      const source = readFileSync(join(mainSrc, file), 'utf8')
      return stringLiterals(source)
        .filter((literal) => GERMAN_LETTERS.test(literal))
        .map((literal) => `${file}: ${JSON.stringify(literal.slice(0, 60))}`)
    })
    expect(
      offenders,
      `German string literals in the main process — move them into shared/mainMessages.ts:\n${offenders.join('\n')}`
    ).toEqual([])
  })
})
