/**
 * E3 (second half): resume — read a repository's run journals and brief a NEW
 * orchestrator on what the previous run left behind.
 *
 * What resume honestly is: the worktrees and `vertragus/*` branches of the old
 * run survive on disk, so a fresh orchestrator can chain follow-up agents onto
 * them with `start_agent{baseBranch}`. What it is NOT: no CLI process comes
 * back, no conversation state is restored, and every question or ticket of the
 * old run is void. The briefing says all of that in as many words — a resume
 * that pretended more would lie.
 *
 * Reading is fail-soft throughout: a corrupt line, a missing `meta.json` or an
 * unreadable directory cost exactly that piece, never the resume.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { agentEventSchema, isAgentEvent, type AgentEvent } from '@shared/schema/events'
import { runMetaSchema, runsDir, type RunMeta } from './journal'

/** One journaled run, as much of it as disk still tells. */
export interface RunRecord {
  workspaceId: string
  /** Absent for a run whose meta.json is missing or corrupt (pre-meta runs). */
  meta?: RunMeta
  events: AgentEvent[]
}

export interface ResumeDeps {
  readdir?: typeof readdir
  readFile?: typeof readFile
  stat?: typeof stat
}

/**
 * The newest journaled run of a profile in this repository. Runs are ordered
 * by `meta.startedAt` when present, else by the journal file's mtime; runs
 * whose meta names a DIFFERENT profile are skipped (two profiles may share a
 * repository), while meta-less runs stay eligible — better an old briefing
 * than a silent "nothing to resume". Returns undefined when no run has a
 * readable journal.
 */
export async function latestRun(
  repoPath: string,
  profileId: string,
  deps: ResumeDeps = {}
): Promise<RunRecord | undefined> {
  const list = deps.readdir ?? readdir
  const read = deps.readFile ?? readFile
  const statFile = deps.stat ?? stat
  const dir = runsDir(repoPath)

  let entries: string[]
  try {
    entries = (await list(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return undefined
  }

  const candidates: Array<{ workspaceId: string; meta?: RunMeta; at: number }> = []
  for (const workspaceId of entries) {
    const runDir = join(dir, workspaceId)
    let meta: RunMeta | undefined
    try {
      const parsed = runMetaSchema.safeParse(JSON.parse(await read(join(runDir, 'meta.json'), 'utf8')))
      if (parsed.success) meta = parsed.data
    } catch {
      /* meta-less runs stay eligible */
    }
    if (meta && meta.profileId !== profileId) continue
    let at = meta?.startedAt
    if (at === undefined) {
      try {
        at = (await statFile(join(runDir, 'events.jsonl'))).mtimeMs
      } catch {
        continue // no meta AND no journal — nothing to resume from
      }
    }
    candidates.push({ workspaceId, meta, at })
  }
  candidates.sort((a, b) => b.at - a.at)

  for (const candidate of candidates) {
    const events = await readRunEvents(repoPath, candidate.workspaceId, deps)
    if (events === undefined) continue
    return { workspaceId: candidate.workspaceId, meta: candidate.meta, events }
  }
  return undefined
}

/** Fail-soft journal read: corrupt lines drop, a missing file is undefined. */
export async function readRunEvents(
  repoPath: string,
  workspaceId: string,
  deps: ResumeDeps = {}
): Promise<AgentEvent[] | undefined> {
  const read = deps.readFile ?? readFile
  let raw: string
  try {
    raw = await read(join(runsDir(repoPath), workspaceId, 'events.jsonl'), 'utf8')
  } catch {
    return undefined
  }
  const events: AgentEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = agentEventSchema.safeParse(JSON.parse(line))
      if (parsed.success) events.push(parsed.data)
    } catch {
      /* a torn last line (crash mid-write) is expected, not an error */
    }
  }
  return events
}

const BRIEFING_AGENT_MAX = 12
const BRIEFING_SUMMARY_MAX = 220

/**
 * The English resume block for the new orchestrator's system prompt: the old
 * run's goal, every agent with its branch and last done report, and the two
 * honest caveats (processes and tickets are gone; verify before trusting).
 */
export function buildResumeBriefing(run: RunRecord): string {
  const cap = (text: string, max: number): string => {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
  }

  // Last-wins per agent: a re-tasked agent's newest done report is the truth.
  const started = new Map<string, { name: string; roleId: string; branch?: string }>()
  const done = new Map<string, { status: string; summary: string; branch?: string }>()
  for (const event of run.events) {
    if (isAgentEvent(event, 'agent_started')) {
      started.set(event.agentId, { name: event.name, roleId: event.roleId, branch: event.branch })
    } else if (isAgentEvent(event, 'agent_done')) {
      done.set(event.agentId, { status: event.status, summary: event.summary, branch: event.branch })
    }
  }

  const agents = [...started.entries()].slice(0, BRIEFING_AGENT_MAX)
  const lines = agents.map(([agentId, agent]) => {
    const report = done.get(agentId)
    const branch = report?.branch ?? agent.branch
    const head = `- ${agent.name} (${agent.roleId})${branch ? ` on branch ${branch}` : ''}`
    return report
      ? `${head} — reported ${report.status}: ${cap(report.summary, BRIEFING_SUMMARY_MAX)}`
      : `${head} — no done report`
  })
  const skipped = started.size - agents.length

  const name = run.meta?.workspaceName ?? run.workspaceId
  return [
    `This workspace resumes an earlier run ("${name}") that ended without finishing.`,
    ...(run.meta?.goal ? [`Goal of that run: ${cap(run.meta.goal, 600)}`] : []),
    ...(lines.length > 0
      ? [
          'Agents of that run and what they reported:',
          ...lines,
          ...(skipped > 0 ? [`(+${skipped} more agents not listed)`] : [])
        ]
      : ['That run started no agents worth listing.']),
    'The branches and worktrees above survived on disk — start follow-up agents with start_agent{baseBranch: "<branch>"} to build on them instead of redoing the work.',
    'No process from that run is still alive, and every question or ticket from it is void. Reports are claims: verify branch contents (inspect_agent, or a reviewer on the branch) before trusting them.'
  ].join('\n')
}
