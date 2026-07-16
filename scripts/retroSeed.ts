import {
  existsSync,
  lstatSync,
  mkdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { INITIAL_ANALYSIS_STATE } from '../src/shared/retroAnalysis'

export const RETRO_ANALYSIS_SEED_PATHS = [
  'overlay/learnings.md',
  'proposals/.gitkeep',
  'state/last-analysis.json'
] as const

type RetroAnalysisSeedPath = (typeof RETRO_ANALYSIS_SEED_PATHS)[number]

const SEED_CONTENT: Record<RetroAnalysisSeedPath, string> = {
  'overlay/learnings.md': '',
  'proposals/.gitkeep': '',
  'state/last-analysis.json': `${JSON.stringify(INITIAL_ANALYSIS_STATE, null, 2)}\n`
}

function resolveSeedRoot(root: string): string {
  const absoluteRoot = resolve(root)
  if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
    throw new Error(`Ungültiges Retro-Checkout-Verzeichnis: ${root}`)
  }
  return absoluteRoot
}

export function resolveRetroAnalysisSeedPath(root: string, artifactPath: string): string {
  const absoluteRoot = resolveSeedRoot(root)
  const target = resolve(absoluteRoot, artifactPath)
  const pathFromRoot = relative(absoluteRoot, target)
  if (
    !pathFromRoot ||
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`Ungültiger Seed-Pfad außerhalb des Retro-Checkouts: ${artifactPath}`)
  }
  return target
}

function assertNoSymlinkParent(root: string, target: string): void {
  const parentFromRoot = relative(root, dirname(target))
  let current = root
  for (const segment of parentFromRoot.split(sep).filter(Boolean)) {
    current = resolve(current, segment)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Seed-Pfad enthält einen symbolischen Link: ${current}`)
    }
  }
}

export function planRetroAnalysisSeed(root: string): RetroAnalysisSeedPath[] {
  return RETRO_ANALYSIS_SEED_PATHS.filter(
    (artifactPath) => !existsSync(resolveRetroAnalysisSeedPath(root, artifactPath))
  )
}

/** Creates only missing bootstrap artifacts and never overwrites reviewed content. */
export function seedRetroAnalysisArtifacts(root: string): RetroAnalysisSeedPath[] {
  const absoluteRoot = resolveSeedRoot(root)
  const created: RetroAnalysisSeedPath[] = []
  for (const artifactPath of planRetroAnalysisSeed(absoluteRoot)) {
    const target = resolveRetroAnalysisSeedPath(absoluteRoot, artifactPath)
    assertNoSymlinkParent(absoluteRoot, target)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, SEED_CONTENT[artifactPath], { encoding: 'utf8', flag: 'wx' })
    created.push(artifactPath)
  }
  return created
}
