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
 *
 * The umlaut alone is not enough. `Unbekanntes Profil ${id}` and `… ist nicht
 * entfernbar — er ist aktiv, fremd oder existiert nicht.` both sat in
 * `workspace/worktreeCleanup.ts` for months and reached the panel's error row
 * in English installs, because neither spells a single ä/ö/ü/ß. So a closed
 * list of German function words backs the letter test up: a German SENTENCE
 * cannot avoid them, while English copy does not contain them.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const mainSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'main')

/** The reliable fingerprint of German copy — when the copy happens to have one. */
const GERMAN_LETTERS = /[äöüÄÖÜß]/

/**
 * German function words, matched whole and case-insensitively. Deliberately
 * only words that carry no meaning in English: an English UI string may say
 * "profile" or "error", but it will not say "ist", "kein" or "wurde". Adding
 * an English homograph ("die", "war", "hat", "in", "man") or a word that also
 * reads as an acronym inside a regex character class ("den", "dem", "des" —
 * `[DEM]` in `workspace/terminalText.ts`) would make the guard cry wolf, and a
 * guard with false positives gets deleted, not fixed.
 */
const GERMAN_STOP_WORDS = new Set([
  'ist',
  'sind',
  'nicht',
  'kein',
  'keine',
  'keinen',
  'keiner',
  'oder',
  'und',
  'aber',
  'auch',
  'noch',
  'schon',
  'nur',
  'wird',
  'wurde',
  'werden',
  'wurden',
  'muss',
  'kann',
  'konnte',
  'darf',
  'soll',
  'bitte',
  'ohne',
  'mit',
  'von',
  'vom',
  'zum',
  'zur',
  'beim',
  'einen',
  'eine',
  'einem',
  'einer',
  'dieser',
  'diese',
  'dieses',
  'welche',
  'sich',
  'wie',
  'wo',
  'weil',
  'damit',
  'profil',
  'fehler',
  'datei',
  'ordner',
  'einstellungen',
  'abbrechen',
  'beenden',
  'gefunden',
  'vorhanden',
  'fehlgeschlagen',
  'ungueltig'
])

const WORD_PATTERN = /[A-Za-zÄÖÜäöüß]+/g

/** Why this literal reads as German copy, or undefined when it does not. */
export function germanReason(literal: string): string | undefined {
  if (GERMAN_LETTERS.test(literal)) return 'umlaut'
  const word = (literal.match(WORD_PATTERN) ?? [])
    .map((token) => token.toLowerCase())
    .find((token) => GERMAN_STOP_WORDS.has(token))
  return word ? `German word "${word}"` : undefined
}

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
    expect(literals.filter((literal) => germanReason(literal))).toHaveLength(1)
  })

  /**
   * The two sentences this list was added for, verbatim as they stood in
   * `workspace/worktreeCleanup.ts`. Both passed the letter test.
   */
  it.each([
    'Unbekanntes Profil ${profileId}',
    'Worktree ${worktreePath} ist nicht entfernbar — er ist aktiv, fremd oder existiert nicht.',
    'Kein Hotkey konfiguriert.',
    'Es liegt kein fertig geladenes Update bereit.'
  ])('catches umlaut-free German: %s', (literal) => {
    expect(germanReason(literal)).toBeDefined()
  })

  /** A guard that fires on English copy would be turned off, not fixed. */
  it.each([
    'The workspace manager is not wired up yet.',
    'no models in the response',
    'resume rejected — no journaled run found in ${repoPath}',
    'Merge conflict — nothing was changed. Conflicting files: ${files}',
    'Vertragus — Settings',
    'promote rejected — unknown workspace ${workspaceId}',
    '/opt/homebrew/bin:/usr/local/bin',
    'application/json'
  ])('leaves English copy alone: %s', (literal) => {
    expect(germanReason(literal)).toBeUndefined()
  })

  it('finds no German literal in src/main/** — new copy goes through mainMessages', () => {
    const offenders = files.flatMap((file) => {
      const source = readFileSync(join(mainSrc, file), 'utf8')
      return stringLiterals(source).flatMap((literal) => {
        const reason = germanReason(literal)
        return reason ? [`${file}: ${reason} in ${JSON.stringify(literal.slice(0, 60))}`] : []
      })
    })
    expect(
      offenders,
      `German string literals in the main process — move them into shared/mainMessages.ts:\n${offenders.join('\n')}`
    ).toEqual([])
  })
})
