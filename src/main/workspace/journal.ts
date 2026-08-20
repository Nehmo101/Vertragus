/**
 * E3 (first half): the run journal — every workspace event, appended as one
 * JSON line to `.vertragus/runs/<workspaceId>/events.jsonl` in the profile's
 * repository. The EventQueue's ring forgets after 1000 events; this file does
 * not, which is what an eventual resume (and any post-mortem) needs.
 *
 * Write-only by design in this track: resume (re-spawning agents into their
 * old worktrees) is deliberately NOT built yet — open `ask_orchestrator`
 * tickets do not survive a crash, and a resume that pretends otherwise would
 * lie. The journal makes the history durable so that gap is honest.
 *
 * Failures never propagate: a full disk or a read-only repo must not take the
 * event loop down. The first failure is warned once, then the journal goes
 * quiet.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentEvent } from '@shared/schema/events'
import { VERTRAGUS_DIR } from '@main/agents/worktree'

export interface RunJournal {
  /** Append one event; serialized internally, never throws. */
  append(event: AgentEvent): void
  /** Absolute path of the journal file (for logs and tests). */
  path: string
}

export interface RunJournalDeps {
  mkdir?: typeof mkdir
  appendFile?: typeof appendFile
  warn?: (message: string, error: unknown) => void
}

export function createRunJournal(
  repoPath: string,
  workspaceId: string,
  deps: RunJournalDeps = {}
): RunJournal {
  const makeDir = deps.mkdir ?? mkdir
  const append = deps.appendFile ?? appendFile
  const warn = deps.warn ?? ((message, error) => console.warn(message, error))
  const dir = join(repoPath, VERTRAGUS_DIR, 'runs', workspaceId)
  const path = join(dir, 'events.jsonl')

  // One chain serializes writes so lines never interleave; `broken` silences
  // the journal after the first failure instead of warning per event.
  let chain: Promise<unknown> = makeDir(dir, { recursive: true })
  let broken = false

  return {
    path,
    append(event) {
      if (broken) return
      chain = chain
        .then(() => append(path, `${JSON.stringify(event)}\n`, 'utf8'))
        .catch((error: unknown) => {
          if (broken) return
          broken = true
          warn(`[journal] stopped writing ${path}:`, error)
        })
    }
  }
}
