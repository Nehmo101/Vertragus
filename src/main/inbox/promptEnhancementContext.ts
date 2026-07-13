import { realpath, readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { profileRepoLocalPath, type WorkspaceProfile } from '@shared/profile'
import {
  PROMPT_ENHANCEMENT_LIMITS,
  redactPromptSecrets,
  type VerifiedPromptWorkspaceContext,
  type VerifiedRepositoryFact
} from './promptEnhancement'

const TRAVERSAL_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/
const DEVICE_PATH = /^(\\\\|\\\?\?\\|\\\?\.\\)/i
const MAX_PACKAGE_JSON_BYTES = 256 * 1024
const CONFIRMED_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'electron-builder.yml',
  'electron-builder.yaml',
  'electron-builder.main.yml',
  'electron.vite.config.ts',
  'vite.config.ts',
  'tsconfig.json'
] as const

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Resolve a fixed inspection target without permitting root escape. */
export function resolvePromptWorkspaceFile(root: string, relativePath: string): string {
  if (!root.trim() || !isAbsolute(root)) {
    throw new Error('Workspace-Pfad muss absolut sein.')
  }
  if (
    !relativePath.trim() ||
    isAbsolute(relativePath) ||
    relativePath.includes('\0') ||
    TRAVERSAL_SEGMENT.test(relativePath)
  ) {
    throw new Error('Workspace-Pfad-Traversal ist nicht erlaubt.')
  }
  const candidate = resolve(root, relativePath)
  if (!isInside(resolve(root), candidate)) {
    throw new Error('Workspace-Pfad-Traversal außerhalb des Repository-Roots ist nicht erlaubt.')
  }
  return candidate
}

export function validatePromptWorkspaceRoot(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed || !isAbsolute(trimmed)) throw new Error('Workspace-Pfad muss absolut sein.')
  if (trimmed.includes('\0')) throw new Error('Workspace-Pfad enthält ungültige Zeichen.')
  if (TRAVERSAL_SEGMENT.test(trimmed)) {
    throw new Error('Workspace-Pfad-Traversal ist nicht erlaubt.')
  }
  if (DEVICE_PATH.test(trimmed)) {
    throw new Error('Geräte-, Netzwerk- oder Spezialpfade sind für Prompt-Kontext nicht erlaubt.')
  }
  return resolve(trimmed)
}

function cleanFact(value: string): string {
  return redactPromptSecrets(value).value.replace(/\s+/g, ' ').trim().slice(0, 500)
}

function addFact(facts: VerifiedRepositoryFact[], checkedAt: number, text: string): void {
  const clean = cleanFact(text)
  if (!clean || facts.length >= PROMPT_ENHANCEMENT_LIMITS.maxRepositoryFacts) return
  facts.push({ text: clean, checkedAt, evidence: 'workspace-inspection' })
}

async function safeExistingFile(rootReal: string, relativePath: string): Promise<string | undefined> {
  const candidate = resolvePromptWorkspaceFile(rootReal, relativePath)
  try {
    const candidateReal = await realpath(candidate)
    if (!isInside(rootReal, candidateReal)) return undefined
    const info = await stat(candidateReal)
    return info.isFile() ? candidateReal : undefined
  } catch {
    return undefined
  }
}

function packageFacts(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    const facts: string[] = []
    if (typeof value.name === 'string' && value.name.trim()) {
      facts.push(`package.json bestätigt den Paketnamen „${value.name.trim()}“.`)
    }
    if (typeof value.description === 'string' && value.description.trim()) {
      facts.push(`Paketbeschreibung: ${value.description.trim()}`)
    }
    if (typeof value.packageManager === 'string' && value.packageManager.trim()) {
      facts.push(`Konfigurierter Paketmanager: ${value.packageManager.trim()}.`)
    }
    if (value.scripts && typeof value.scripts === 'object' && !Array.isArray(value.scripts)) {
      const names = Object.keys(value.scripts).filter(Boolean).sort().slice(0, 30)
      if (names.length > 0) facts.push(`Verfügbare package.json-Skripte: ${names.join(', ')}.`)
    }
    const dependencyNames = ['dependencies', 'devDependencies']
      .flatMap((key) => {
        const section = value[key]
        return section && typeof section === 'object' && !Array.isArray(section)
          ? Object.keys(section)
          : []
      })
      .filter(Boolean)
      .sort()
      .slice(0, 40)
    if (dependencyNames.length > 0) {
      facts.push(`Deklarierte JavaScript-Abhängigkeiten umfassen: ${dependencyNames.join(', ')}.`)
    }
    return facts
  } catch {
    return []
  }
}

/**
 * Inspects only a small fixed allow-list. No renderer-supplied path or artifact
 * path is read, and symlinks escaping the repository root are ignored.
 */
export async function inspectPromptWorkspaceContext(
  profile: WorkspaceProfile
): Promise<VerifiedPromptWorkspaceContext> {
  const context: VerifiedPromptWorkspaceContext = { name: profile.name }
  const configuredRoot = profileRepoLocalPath(profile)
  if (!configuredRoot) return context

  const root = validatePromptWorkspaceRoot(configuredRoot)
  const rootReal = await realpath(root)
  const rootInfo = await stat(rootReal)
  if (!rootInfo.isDirectory()) throw new Error('Workspace-Pfad ist kein Verzeichnis.')

  const checkedAt = Date.now()
  const facts: VerifiedRepositoryFact[] = []
  const foundFiles: string[] = []
  for (const relativePath of CONFIRMED_FILES) {
    const file = await safeExistingFile(rootReal, relativePath)
    if (!file) continue
    foundFiles.push(relativePath)
    if (relativePath === 'package.json') {
      const info = await stat(file)
      if (info.size <= MAX_PACKAGE_JSON_BYTES) {
        for (const fact of packageFacts(await readFile(file, 'utf8'))) addFact(facts, checkedAt, fact)
      }
    }
  }
  if (foundFiles.length > 0) {
    addFact(facts, checkedAt, `Im Repository bestätigt vorhandene Dateien: ${foundFiles.join(', ')}.`)
  }

  const workflowsRoot = resolvePromptWorkspaceFile(rootReal, '.github/workflows')
  try {
    const workflowsReal = await realpath(workflowsRoot)
    if (isInside(rootReal, workflowsReal) && (await stat(workflowsReal)).isDirectory()) {
      const workflows = (await readdir(workflowsReal))
        .filter((name) => /^[A-Za-z0-9._-]+\.ya?ml$/i.test(name))
        .sort()
        .slice(0, 20)
      if (workflows.length > 0) {
        addFact(facts, checkedAt, `Bestätigte GitHub-Workflow-Dateien: ${workflows.join(', ')}.`)
      }
    }
  } catch {
    // Optional metadata; absence or access failure is not a repository fact.
  }

  if (facts.length > 0) context.repositoryFacts = facts
  return context
}
