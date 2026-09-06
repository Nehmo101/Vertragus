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
  /** First the configured match limit matches of this run. */
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

