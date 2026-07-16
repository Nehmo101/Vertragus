import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INITIAL_ANALYSIS_STATE, synthesisOutputSchema } from '../src/shared/retroAnalysis'
import {
  planRetroAnalysisSeed,
  resolveRetroAnalysisSeedPath,
  RETRO_ANALYSIS_SEED_PATHS,
  seedRetroAnalysisArtifacts
} from './retroSeed'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-retro-seed-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('retro analysis bootstrap seed', () => {
  it('creates every missing artifact with schema-conformant initial content', () => {
    const root = tempRoot()

    expect(planRetroAnalysisSeed(root)).toEqual(RETRO_ANALYSIS_SEED_PATHS)
    expect(seedRetroAnalysisArtifacts(root)).toEqual(RETRO_ANALYSIS_SEED_PATHS)

    const overlay = readFileSync(join(root, 'overlay', 'learnings.md'), 'utf8')
    expect(
      synthesisOutputSchema.safeParse({ overlay, proposals: [], notes: '' }).success
    ).toBe(true)
    expect(overlay.split('\n')).toHaveLength(1)
    expect(Buffer.byteLength(overlay, 'utf8')).toBeLessThanOrEqual(16 * 1024)
    expect(readFileSync(join(root, 'proposals', '.gitkeep'), 'utf8')).toBe('')
    expect(JSON.parse(readFileSync(join(root, 'state', 'last-analysis.json'), 'utf8'))).toEqual(
      INITIAL_ANALYSIS_STATE
    )
  })

  it('is idempotent and never overwrites reviewed or partially existing artifacts', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'overlay'), { recursive: true })
    writeFileSync(join(root, 'overlay', 'learnings.md'), '# Menschlich geprüft\n', 'utf8')

    expect(planRetroAnalysisSeed(root)).toEqual([
      'proposals/.gitkeep',
      'state/last-analysis.json'
    ])
    expect(seedRetroAnalysisArtifacts(root)).toEqual([
      'proposals/.gitkeep',
      'state/last-analysis.json'
    ])
    expect(seedRetroAnalysisArtifacts(root)).toEqual([])
    expect(readFileSync(join(root, 'overlay', 'learnings.md'), 'utf8')).toBe(
      '# Menschlich geprüft\n'
    )
  })

  it('rejects an invalid root and path traversal outside the checkout', () => {
    const root = tempRoot()

    expect(() => resolveRetroAnalysisSeedPath(root, '../leak.md')).toThrow(/außerhalb/)
    expect(() => planRetroAnalysisSeed(join(root, 'missing'))).toThrow(/Ungültiges/)
  })
})
