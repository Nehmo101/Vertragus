/**
 * S1: the spill store — oversized tool output goes verbatim into a file under
 * `.vertragus/runs/<workspaceId>/spill/`, and the model gets a head/tail
 * preview plus the absolute path instead of a hard truncation. The files live
 * in the REPOSITORY path (same tree as the run journal), so every
 * orchestrator — root or lead, each in its own worktree — can read them with
 * the absolute path the preview names.
 *
 * Failures never propagate: a full disk or a read-only repo degrades the tool
 * result to the old inline behaviour, never to a tool error. Same fail-soft
 * chain as the journal: the first failure warns once, then the store goes
 * quiet and `save` answers `undefined`.
 *
 * No retention in v1 on purpose (like dsh): the spill directory hangs off the
 * existing run directory and is cleaned up with it, or not at all.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runsDir } from './journal'

export interface SpillStore {
  /**
   * Write `content` verbatim; resolves to the absolute file path, or
   * `undefined` on ANY failure (fail-soft — callers degrade, never error).
   */
  save(name: string, content: string): Promise<string | undefined>
}

export interface SpillStoreDeps {
  mkdir?: typeof mkdir
  writeFile?: typeof writeFile
  warn?: (message: string, error: unknown) => void
}

/**
 * File names must survive every filesystem and stay grep-friendly in a tool
 * result, so anything outside [a-z0-9-] collapses to one dash. An empty
 * remainder still gets a name — the seq prefix keeps it unique either way.
 */
function normalizeName(name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return safe || 'output'
}

export function createSpillStore(
  repoPath: string,
  workspaceId: string,
  deps: SpillStoreDeps = {}
): SpillStore {
  const makeDir = deps.mkdir ?? mkdir
  const write = deps.writeFile ?? writeFile
  const warn = deps.warn ?? ((message, error) => console.warn(message, error))
  const dir = join(runsDir(repoPath), workspaceId, 'spill')

  // The seq is a LOCAL counter of this store — monotonic per run, no disk
  // scan. mkdir is lazy (most runs never spill) and shared, so concurrent
  // saves race on one promise instead of on the directory.
  let seq = 0
  let ready: Promise<unknown> | undefined
  let broken = false

  return {
    async save(name, content) {
      if (broken) return undefined
      seq += 1
      const path = join(dir, `${seq}-${normalizeName(name)}.txt`)
      try {
        ready ??= makeDir(dir, { recursive: true })
        await ready
        await write(path, content, 'utf8')
        return path
      } catch (error) {
        if (!broken) {
          broken = true
          warn(`[spill] stopped writing ${dir}:`, error)
        }
        return undefined
      }
    }
  }
}
