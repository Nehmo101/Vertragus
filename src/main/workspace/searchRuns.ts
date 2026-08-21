/**
 * S5: search_runs — full-text search over the run journals resume already
 * reads. E2-briefing and retro learnings are push; this is the pull side: an
 * orchestrator that wonders "did an earlier run hit this build quirk?" greps
 * the history instead of re-solving it.
 *
 * Deliberately NOT a regex engine and NOT ripgrep: the query is a
 * case-insensitive substring (whitespace-flexible — any whitespace run in
 * query or journal matches any other), because regex would raise injection and
 * cost questions v1 does not need, and journals are small enough for plain
 * line streaming. A journal over 5 MB is skipped and NAMED in the result —
 * a silent gap would make "no match" a lie.
 *
 * Reading is fail-soft exactly like resume.ts (same injectable fs deps): a
 * corrupt line, missing meta or unreadable directory costs that piece, never
 * the search. The CURRENT run is included for free — its journal is on disk
 * like every other.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runMetaSchema, runsDir, type RunMeta } from './journal'
import { readRunEvents, type ResumeDeps } from './resume'

/** One matched line of one run's journal (seq 0 + type "meta" = meta.json hit). */
export interface RunSearchMatch {
  seq: number
  type: string
  agentId?: string
  /** ±120 chars around the first match in the line, whitespace-flattened. */
  excerpt: string
}

/** One run with at least one match, newest runs first. */
export interface RunSearchHit {
  workspaceId: string
  workspaceName?: string
  goal?: string
  startedAt?: number
  /** First {@link SearchRunsOptions.maxHitsPerRun} matches of this run. */
  matches: RunSearchMatch[]
  /** ALL matches of this run — larger than `matches.length` when capped. */
  totalMatches: number
}

/** Nothing silent: hits, how many runs were actually read, and what was not. */
export interface RunSearchResult {
  hits: RunSearchHit[]
  /** Runs whose journal/meta this search actually read. */
  searchedRuns: number
  /** workspaceIds whose journal exceeded the size cap and was NOT searched. */
  skipped: string[]
}

export interface SearchRunsOptions {
  /** Newest runs considered, by meta.startedAt else journal mtime. Default 20. */
  maxRuns?: number
  /** Matches kept per run (totalMatches still counts all). Default 5. */
  maxHitsPerRun?: number
  /** Runs with hits before the search stops early. Default 8. */
  maxResults?: number
}

const DEFAULT_MAX_RUNS = 20
const DEFAULT_MAX_HITS_PER_RUN = 5
const DEFAULT_MAX_RESULTS = 8
/** A journal beyond this is skipped (and named), not streamed — see header. */
export const MAX_JOURNAL_BYTES = 5 * 1024 * 1024
const EXCERPT_RADIUS = 120

/** Collapse whitespace runs — the one normalization both sides get. */
const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Excerpt around the FIRST occurrence of `needle` in `line`, or undefined. */
function matchExcerpt(line: string, needle: string): string | undefined {
  const flat = flatten(line)
  const index = flat.toLowerCase().indexOf(needle)
  if (index < 0) return undefined
  return flat.slice(Math.max(0, index - EXCERPT_RADIUS), index + needle.length + EXCERPT_RADIUS)
}

/**
 * Search the newest run journals of a repository for a plain substring.
 * Matched per run: every serialized event line plus `meta.goal` and
 * `meta.workspaceName` (reported as a pseudo-match with seq 0, type "meta").
 */
export async function searchRuns(
  repoPath: string,
  query: string,
  opts: SearchRunsOptions = {},
  deps: ResumeDeps = {}
): Promise<RunSearchResult> {
  const list = deps.readdir ?? readdir
  const read = deps.readFile ?? readFile
  const statFile = deps.stat ?? stat
  const maxRuns = opts.maxRuns ?? DEFAULT_MAX_RUNS
  const maxHitsPerRun = opts.maxHitsPerRun ?? DEFAULT_MAX_HITS_PER_RUN
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS

  const empty: RunSearchResult = { hits: [], searchedRuns: 0, skipped: [] }
  const needle = flatten(query).toLowerCase()
  if (needle.length === 0) return empty

  const dir = runsDir(repoPath)
  let entries: string[]
  try {
    entries = (await list(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return empty // a repo without journals has honestly searched zero runs
  }

  // Same ordering rule as resume's latestRun: meta.startedAt when present,
  // else the journal's mtime; a directory with neither has nothing to search.
  const candidates: Array<{ workspaceId: string; meta?: RunMeta; at: number }> = []
  for (const workspaceId of entries) {
    const runDir = join(dir, workspaceId)
    let meta: RunMeta | undefined
    try {
      const parsed = runMetaSchema.safeParse(JSON.parse(await read(join(runDir, 'meta.json'), 'utf8')))
      if (parsed.success) meta = parsed.data
    } catch {
      /* meta-less runs stay searchable */
    }
    let at = meta?.startedAt
    if (at === undefined) {
      try {
        at = (await statFile(join(runDir, 'events.jsonl'))).mtimeMs
      } catch {
        continue // no meta AND no journal — nothing to search
      }
    }
    candidates.push({ workspaceId, meta, at })
  }
  candidates.sort((a, b) => b.at - a.at)

  const hits: RunSearchHit[] = []
  const skipped: string[] = []
  let searchedRuns = 0
  for (const candidate of candidates.slice(0, maxRuns)) {
    if (hits.length >= maxResults) break

    // The size cap is checked BEFORE the read — the whole point is not to
    // pull a runaway journal into memory. Skipped runs are named, not counted
    // as searched, so the result never claims coverage it did not have.
    try {
      const info = await statFile(join(dir, candidate.workspaceId, 'events.jsonl'))
      if (info.size > MAX_JOURNAL_BYTES) {
        skipped.push(candidate.workspaceId)
        continue
      }
    } catch {
      /* no journal — meta may still match below */
    }
    searchedRuns += 1

    const matches: RunSearchMatch[] = []
    let totalMatches = 0
    const record = (match: RunSearchMatch): void => {
      totalMatches += 1
      if (matches.length < maxHitsPerRun) matches.push(match)
    }

    // meta.goal and workspaceName join the searchable text — "which run was
    // about the parser?" must not depend on an agent having said so in an event.
    const meta = candidate.meta
    const metaExcerpt =
      (meta?.goal ? matchExcerpt(meta.goal, needle) : undefined) ??
      (meta?.workspaceName ? matchExcerpt(meta.workspaceName, needle) : undefined)
    if (metaExcerpt !== undefined) record({ seq: 0, type: 'meta', excerpt: metaExcerpt })

    const events = (await readRunEvents(repoPath, candidate.workspaceId, deps)) ?? []
    for (const event of events) {
      const excerpt = matchExcerpt(JSON.stringify(event), needle)
      if (excerpt === undefined) continue
      const agentId = (event as { agentId?: string }).agentId
      record({ seq: event.seq, type: event.type, ...(agentId ? { agentId } : {}), excerpt })
    }

    if (totalMatches === 0) continue
    hits.push({
      workspaceId: candidate.workspaceId,
      ...(meta?.workspaceName ? { workspaceName: meta.workspaceName } : {}),
      ...(meta?.goal ? { goal: meta.goal } : {}),
      ...(meta?.startedAt !== undefined ? { startedAt: meta.startedAt } : {}),
      matches,
      totalMatches
    })
  }
  return { hits, searchedRuns, skipped }
}
