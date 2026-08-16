/**
 * Pre-accept Kimi Code's "Trust this folder?" dialog for the directories
 * Vertragus starts agents in — the Kimi twin of {@link ensureClaudeWorkspaceTrust}.
 *
 * Why it matters more here than it looks: the dialog is modal, it takes the
 * keyboard *before* the composer exists, and every agent gets a brand-new
 * worktree — so it appears for every single Kimi agent. Measured against
 * kimi-code 0.34.0: the seed handshake waits for the CLI to take the keyboard,
 * the trust dialog is what took it, the assignment was typed into a menu that
 * ignores text, and the submitting Enter answered "Trust this folder". The
 * agent then sat in an empty composer with no task and no error — the exact
 * silent-handover failure this whole path exists to prevent.
 *
 * Kimi stores the answer as one small JSON file per folder:
 *
 *   ~/.kimi-code/workspace-trust/wd_<slug>_<hash>
 *   {"root":"C:\\path\\to\\folder","trustedAt":1786881314299}
 *
 * `<slug>` is the lower-cased last path segment and `<hash>` the first 12 hex
 * characters of the SHA-256 over the root path with forward slashes — both
 * derived from the real store on this machine and verified against four
 * independent entries. Vertragus only ever ADDS files for directories it
 * launches in; nothing existing is read, rewritten or removed, and every
 * failure is soft (the user simply sees the dialog).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/** Kimi's state directory inside the home directory. */
export const KIMI_HOME_DIR = '.kimi-code'

/** Where the per-folder trust records live. */
export const KIMI_TRUST_DIR = 'workspace-trust'

export interface KimiTrustDeps {
  /** Home directory holding `.kimi-code`. Tests inject a temp dir. */
  homeDir?: () => string
  writeFile?: (path: string, contents: string) => void
  makeDir?: (path: string) => void
  /** Canonical on-disk spelling of a path; see {@link kimiTrustRoots}. */
  realPath?: (path: string) => string
  now?: () => number
  warn?: (message: string, detail?: unknown) => void
}

export interface KimiTrustResult {
  outcome: 'granted' | 'skipped'
  /** Absolute paths of the trust files that were written. */
  files: string[]
  reason?: string
}

/**
 * The record's file name: `wd_<slug>_<hash>`.
 *
 * The hash is taken over the forward-slash form and is case-SENSITIVE — the
 * store on this machine contains `C:/git/uwe` and hashes it as spelled, so a
 * different casing is a different folder as far as Kimi is concerned. That is
 * why {@link kimiTrustRoots} writes the spellings rather than guessing one.
 */
export function kimiTrustFileName(root: string): string {
  const slug =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'wd'
  const hash = createHash('sha256').update(root.replace(/\\/g, '/'), 'utf8').digest('hex')
  return `wd_${slug}_${hash.slice(0, 12)}`
}

/**
 * Every spelling of one directory Kimi might record as its working directory:
 * the resolved path and its canonical on-disk casing. Both are cheap, and an
 * unused trust record is inert — an unmatched one means the dialog appears.
 */
export function kimiTrustRoots(workspaceDir: string, realPath?: (path: string) => string): string[] {
  const base = resolve(workspaceDir)
  const roots = new Set([base])
  if (realPath) {
    try {
      roots.add(realPath(base))
    } catch {
      // The directory may not exist yet — the resolved spelling is the likely
      // one anyway, and a missing second variant only risks the dialog.
    }
  }
  return [...roots]
}

/**
 * Make sure Kimi Code considers `workspaceDir` trusted. Never throws.
 *
 * The file is written unconditionally rather than read-then-written: it holds
 * nothing but the folder and a timestamp, so a rewrite costs one small write
 * and cannot lose state that matters.
 */
export function ensureKimiWorkspaceTrust(
  workspaceDir: string,
  deps: KimiTrustDeps = {}
): KimiTrustResult {
  const warn =
    deps.warn ??
    ((message: string, detail?: unknown): void => {
      console.warn(`[kimi-trust] ${message}`, detail ?? '')
    })

  const dir = workspaceDir.trim()
  if (!dir) return { outcome: 'skipped', files: [], reason: 'no workspace directory' }

  const home = (deps.homeDir ?? homedir)()
  const trustDir = join(home, KIMI_HOME_DIR, KIMI_TRUST_DIR)
  const makeDir = deps.makeDir ?? ((path: string) => void mkdirSync(path, { recursive: true }))
  const writeFile =
    deps.writeFile ?? ((path: string, text: string) => writeFileSync(path, text, 'utf8'))
  const now = deps.now ?? Date.now
  const roots = kimiTrustRoots(dir, deps.realPath ?? ((path: string) => realpathSync.native(path)))

  const files: string[] = []
  try {
    makeDir(trustDir)
    for (const root of roots) {
      const file = join(trustDir, kimiTrustFileName(root))
      writeFile(file, JSON.stringify({ root, trustedAt: now() }))
      files.push(file)
    }
  } catch (error) {
    warn(`could not write the trust record under ${trustDir} — the dialog may appear.`, error)
    return { outcome: 'skipped', files, reason: 'write failed' }
  }

  return { outcome: 'granted', files }
}
