/**
 * Cheap / scout repo probe for the goal compiler.
 *
 * No index, no RAG: a handful of well-known files and first-level folders,
 * the same skim a human does before delegating. Fail-soft — a missing file
 * is absence, not an error.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepoFacts } from '@shared/goal/brief'
import { looksLikeInvariant } from '@shared/goal/recipes'

const SKIP_DIRS = new Set([
  '.git',
  '.vertragus',
  'node_modules',
  'dist',
  'out',
  'coverage',
  '.turbo',
  'build'
])

const DOC_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'README.de.md']
const DOC_CAP = 8_000
const INVARIANT_MAX = 12
const SCRIPT_MAX = 12
const MODULE_MAX = 24

export type ProbeDepth = 'cheap' | 'scout'

async function readCapped(path: string, cap = DOC_CAP): Promise<string | undefined> {
  try {
    const text = await readFile(path, 'utf8')
    const trimmed = text.trim()
    if (!trimmed) return undefined
    return trimmed.length <= cap ? trimmed : `${trimmed.slice(0, cap)}\n…(truncated)`
  } catch {
    return undefined
  }
}

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function invariantsFrom(markdown: string): string[] {
  const lines: string[] = []
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('- ') && !line.startsWith('* ')) continue
    const body = line.slice(2).trim()
    if (looksLikeInvariant(body)) {
      lines.push(body)
    }
    if (lines.length >= INVARIANT_MAX) break
  }
  return lines
}

function productFrom(markdown: string): string | undefined {
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') === false) continue
    const title = line.replace(/^#+\s+/, '').trim()
    if (title) return title.slice(0, 80)
  }
  return undefined
}

async function packageScripts(repoPath: string): Promise<string[]> {
  const raw = await readCapped(join(repoPath, 'package.json'), 20_000)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
    const names = Object.keys(parsed.scripts ?? {})
    const preferred = names.filter((name) =>
      /^(test|lint|typecheck|ci|quality|build)(:|$)/.test(name)
    )
    return (preferred.length > 0 ? preferred : names).slice(0, SCRIPT_MAX)
  } catch {
    return []
  }
}

/**
 * Probe a repository. `cheap` is docs + package.json + top-level dirs.
 * `scout` also lists apps/, packages/, src/, terra/ and looks for
 * ARCHITECTURE.md / quality-contract / playwright config.
 */
export async function probeRepo(repoPath: string, depth: ProbeDepth): Promise<RepoFacts> {
  const docs: string[] = []
  let product: string | undefined
  const invariants: string[] = []

  for (const name of DOC_CANDIDATES) {
    const text = await readCapped(join(repoPath, name))
    if (!text) continue
    docs.push(name)
    if (!product) product = productFrom(text)
    if (invariants.length < INVARIANT_MAX) {
      for (const line of invariantsFrom(text)) {
        if (invariants.length >= INVARIANT_MAX) break
        invariants.push(line)
      }
    }
    if (depth === 'cheap') break
  }

  const scripts = await packageScripts(repoPath)
  const top = await listDirs(repoPath)
  const modules: Array<{ id: string; path: string }> = top.slice(0, MODULE_MAX).map((name) => ({
    id: name,
    path: name
  }))
  const showcases: string[] = []

  if (depth === 'scout') {
    for (const nest of ['apps', 'packages', 'src', 'terra', 'docs']) {
      if (!top.includes(nest)) continue
      const children = await listDirs(join(repoPath, nest))
      for (const child of children) {
        if (modules.length >= MODULE_MAX) break
        const path = `${nest}/${child}`
        if (!modules.some((module) => module.path === path)) {
          modules.push({ id: child, path })
        }
      }
    }
    for (const extra of [
      'ARCHITECTURE.md',
      'terra/art-direction/quality-contract.json',
      'playwright.config.ts',
      'playwright.config.mjs'
    ]) {
      const text = await readCapped(join(repoPath, extra), 2_000)
      if (text) {
        docs.push(extra)
        if (extra.includes('quality-contract') || extra.includes('playwright')) {
          showcases.push(extra)
        }
      }
    }
  }

  return {
    ...(product ? { product } : {}),
    docs,
    scripts,
    modules,
    invariants,
    showcases
  }
}
