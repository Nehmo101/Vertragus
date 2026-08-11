/**
 * Pre-accept Claude Code's "Do you trust the files in this folder?" dialog for
 * the directories Vertragus starts agents in.
 *
 * Why this is not a papercut: the dialog is *modal inside the CLI*. An
 * orchestrator that boots into it answers no MCP call, seeds no task and looks
 * exactly like a hung launch — and it appears again for every worktree, i.e.
 * once per subagent. Vertragus only ever launches in a repo path the user typed
 * into a profile themselves (or in a worktree Vertragus created underneath it),
 * so the trust decision has already been made by a human; re-asking it in a
 * window they may not even be looking at is pure friction.
 *
 * Claude Code stores the answer in `~/.claude.json` under
 * `projects["<dir>"].hasTrustDialogAccepted`. We only ever *add* that one key
 * for the exact directories we launch in. Everything else in that file — model
 * caches, MCP servers, per-project history, other projects — is round-tripped
 * untouched, the write is atomic (temp + rename), and every failure mode is
 * soft: a file we do not understand is left alone and the launch proceeds with
 * the dialog rather than with a corrupted config.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Name of the CLI state file inside the home directory. */
export const CLAUDE_CONFIG_FILE = '.claude.json'

/** The single key Vertragus ever writes. */
export const TRUST_KEY = 'hasTrustDialogAccepted'

export interface ClaudeTrustDeps {
  /** Home directory holding `.claude.json`. Tests inject a temp dir. */
  homeDir?: () => string
  readFile?: (path: string) => string
  writeFile?: (path: string, contents: string) => void
  rename?: (from: string, to: string) => void
  removeFile?: (path: string) => void
  /** Canonical on-disk spelling of a path; see {@link trustKeysFor}. */
  realPath?: (path: string) => string
  warn?: (message: string, detail?: unknown) => void
  /** Suffix source for the temp file; injected so tests get a stable name. */
  tempSuffix?: () => string
}

/**
 * What happened, so callers (and tests) can tell "already fine" from "we fixed
 * it" from "we did not dare".
 */
export type ClaudeTrustOutcome = 'granted' | 'already-trusted' | 'skipped'

export interface ClaudeTrustResult {
  outcome: ClaudeTrustOutcome
  /** The `projects` keys that now carry the trust flag. */
  keys: string[]
  /** Present for `skipped`: why nothing was written. */
  reason?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Every spelling of one directory that Claude Code might key its config by.
 *
 * The real file on this machine contains all three shapes side by side —
 * `C:/git/UWE`, `C:\git\Orca-Strator` and lower-cased duplicates — because the
 * key is whatever the CLI's working directory string happened to be. A trust
 * entry under the wrong spelling is simply not found, so we write the variants
 * instead of guessing: the resolved path, its canonical on-disk casing, and the
 * forward-slash form of both. Extra keys carrying only `hasTrustDialogAccepted`
 * are inert for every consumer of the file.
 */
export function trustKeysFor(workspaceDir: string, realPath?: (path: string) => string): string[] {
  const base = resolve(workspaceDir)
  const spellings = [base]
  if (realPath) {
    try {
      spellings.push(realPath(base))
    } catch {
      // Directory does not exist yet (a worktree is created right after this)
      // — the resolved spelling is all we have, and it is the likely one.
    }
  }
  const keys = new Set<string>()
  for (const spelling of spellings) {
    keys.add(spelling)
    keys.add(spelling.replace(/\\/g, '/'))
  }
  return [...keys]
}

/**
 * Make sure Claude Code considers `workspaceDir` trusted. Never throws.
 *
 * Idempotent by construction: when every key already says `true` the file is
 * not rewritten at all, which also keeps us out of the way of a Claude process
 * writing its own state at the same moment.
 */
export function ensureClaudeWorkspaceTrust(
  workspaceDir: string,
  deps: ClaudeTrustDeps = {}
): ClaudeTrustResult {
  const warn =
    deps.warn ??
    ((message: string, detail?: unknown): void => {
      console.warn(`[claude-trust] ${message}`, detail ?? '')
    })

  const dir = workspaceDir.trim()
  if (!dir) return { outcome: 'skipped', keys: [], reason: 'no workspace directory' }

  const home = (deps.homeDir ?? homedir)()
  const configPath = join(home, CLAUDE_CONFIG_FILE)
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'))

  let raw: string
  try {
    raw = readFile(configPath)
  } catch (error) {
    // No file means Claude Code has never run as this user. Creating one from
    // the outside would fight its onboarding; the dialog is the lesser evil.
    warn(`${configPath} is not readable — leaving the trust dialog to the user.`, error)
    return { outcome: 'skipped', keys: [], reason: 'config unreadable' }
  }

  let config: unknown
  try {
    config = JSON.parse(raw)
  } catch (error) {
    warn(`${configPath} is not valid JSON — not touching it.`, error)
    return { outcome: 'skipped', keys: [], reason: 'config not json' }
  }

  if (!isPlainObject(config)) {
    warn(`${configPath} is not a JSON object — not touching it.`)
    return { outcome: 'skipped', keys: [], reason: 'config not an object' }
  }

  const projectsValue = config.projects
  if (projectsValue !== undefined && !isPlainObject(projectsValue)) {
    warn(`${configPath} has an unexpected "projects" shape — not touching it.`)
    return { outcome: 'skipped', keys: [], reason: 'projects not an object' }
  }
  const projects: Record<string, unknown> = isPlainObject(projectsValue) ? projectsValue : {}

  const keys = trustKeysFor(dir, deps.realPath ?? ((path: string) => realpathSync.native(path)))
  let changed = false
  for (const key of keys) {
    const entry = projects[key]
    if (entry === undefined) {
      // A minimal entry is enough — the CLI fills the rest on its next run.
      projects[key] = { [TRUST_KEY]: true }
      changed = true
      continue
    }
    if (!isPlainObject(entry)) {
      warn(`projects["${key}"] is not an object — leaving that entry alone.`)
      continue
    }
    if (entry[TRUST_KEY] === true) continue
    entry[TRUST_KEY] = true
    changed = true
  }

  if (!changed) return { outcome: 'already-trusted', keys }

  const next = { ...config, projects }
  // Two spaces: the CLI writes the file this way, so a Vertragus write does not
  // show up as a whole-file diff in the user's backups.
  const contents = `${JSON.stringify(next, null, 2)}\n`
  const suffix = (deps.tempSuffix ?? (() => randomBytes(6).toString('hex')))()
  const tempPath = join(dirname(configPath), `.claude.json.vertragus-${suffix}.tmp`)
  const writeFile = deps.writeFile ?? ((path: string, text: string) => writeFileSync(path, text, 'utf8'))
  const rename = deps.rename ?? ((from: string, to: string) => renameSync(from, to))
  const removeFile = deps.removeFile ?? ((path: string) => unlinkSync(path))

  try {
    writeFile(tempPath, contents)
    rename(tempPath, configPath)
  } catch (error) {
    warn(`could not update ${configPath} — the trust dialog may appear.`, error)
    try {
      removeFile(tempPath)
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    return { outcome: 'skipped', keys, reason: 'write failed' }
  }

  return { outcome: 'granted', keys }
}
