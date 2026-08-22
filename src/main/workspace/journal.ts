/**
 * E3 (first half): the run journal — every workspace event, appended as one
 * JSON line to `.vertragus/runs/<workspaceId>/events.jsonl` in the profile's
 * repository, plus a `meta.json` with the run's identity and goal. The
 * EventQueue's ring forgets after 1000 events; these files do not, which is
 * what resume (see `resume.ts`) and any post-mortem need.
 *
 * Resume reads this history to brief a NEW orchestrator — it never re-spawns
 * the old CLI processes, and open `ask_orchestrator` tickets do not survive; a
 * resume that pretended otherwise would lie.
 *
 * Failures never propagate: a full disk or a read-only repo must not take the
 * event loop down. The first failure is warned once, then the journal goes
 * quiet.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentEvent } from '@shared/schema/events'
import { VERTRAGUS_DIR } from '@main/agents/worktree'

/** Identity of one run, written once at start. Everything else is events. */
export const runMetaSchema = z
  .object({
    workspaceId: z.string().min(1),
    profileId: z.string().min(1),
    workspaceName: z.string().min(1),
    goal: z.string().max(20_000).optional(),
    startedAt: z.number().finite(),
    /** Set when this run itself was started as a resume of an older run. */
    resumedFrom: z.string().min(1).optional()
  })
  .strict()
export type RunMeta = z.infer<typeof runMetaSchema>

/** Where a repository keeps its run journals. */
export function runsDir(repoPath: string): string {
  return join(repoPath, VERTRAGUS_DIR, 'runs')
}

/**
 * The one directory a single run leaves behind: `events.jsonl`, `meta.json`,
 * `tasks.json` and `spill/`. Named here because it is the folder the panel's
 * run-artifact button hands to the OS file manager — the artefacts are one
 * place on disk, and only one function may decide where that is.
 */
export function runDir(repoPath: string, workspaceId: string): string {
  return join(runsDir(repoPath), workspaceId)
}

export interface RunJournal {
  /** Append one event; serialized internally, never throws. */
  append(event: AgentEvent): void
  /** Write the run's `meta.json` once; same fail-soft chain as append. */
  writeMeta(meta: RunMeta): void
  /** Absolute path of the journal file (for logs and tests). */
  path: string
}

export interface RunJournalDeps {
  mkdir?: typeof mkdir
  appendFile?: typeof appendFile
  writeFile?: typeof writeFile
  warn?: (message: string, error: unknown) => void
}

export function createRunJournal(
  repoPath: string,
  workspaceId: string,
  deps: RunJournalDeps = {}
): RunJournal {
  const makeDir = deps.mkdir ?? mkdir
  const append = deps.appendFile ?? appendFile
  const write = deps.writeFile ?? writeFile
  const warn = deps.warn ?? ((message, error) => console.warn(message, error))
  const dir = runDir(repoPath, workspaceId)
  const path = join(dir, 'events.jsonl')

  // One chain serializes writes so lines never interleave; `broken` silences
  // the journal after the first failure instead of warning per event.
  let chain: Promise<unknown> = makeDir(dir, { recursive: true })
  let broken = false

  function enqueue(task: () => Promise<unknown>): void {
    if (broken) return
    chain = chain.then(task).catch((error: unknown) => {
      if (broken) return
      broken = true
      warn(`[journal] stopped writing ${path}:`, error)
    })
  }

  return {
    path,
    append(event) {
      enqueue(() => append(path, `${JSON.stringify(event)}\n`, 'utf8'))
    },
    writeMeta(meta) {
      enqueue(() => write(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8'))
    }
  }
}
