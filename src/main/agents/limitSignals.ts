/**
 * Heuristic detection of provider usage-limit signals in an agent's terminal
 * output.
 *
 * The agent CLIs (claude / codex / cursor) expose no queryable "remaining quota"
 * API, so the only signal we have is the human-readable limit banner they print
 * (e.g. "You've reached your 5-hour limit", "weekly limit"). We match those
 * phrasings so the UI can offer a handoff BEFORE the agent is fully cut off.
 *
 * This is best-effort by nature -- phrasings drift between CLI versions. Keep the
 * pattern table below as the single place to maintain them; the manual "handoff"
 * button is always available as the reliable path.
 */
import type { AgentProviderId } from '@shared/providers'
import { LIMIT_KIND_LABELS, type LimitKind } from '@shared/agents'

// Strip ANSI/VT control sequences so matching (and the handoff briefing) see
// plain text rather than colour codes. This is the well-known `ansi-regex`
// pattern (OSC terminated by BEL, plus CSI), written with \x escapes so there
// are no literal control bytes in source.
// prettier-ignore
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x1b\x9b][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\x07)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '')
}

interface LimitPattern {
  re: RegExp
  kind: LimitKind
}

/**
 * Ordered most-specific first. `[^.\n]{0,N}` lets a few words sit between the
 * key tokens ("weekly usage limit", "Fable model weekly limit") without
 * spanning sentences/lines.
 */
const COMMON_PATTERNS: LimitPattern[] = [
  { re: /\bfable\b[^.\n]{0,40}\bweekly\b[^.\n]{0,20}\blimit\b/i, kind: 'weekly-fable' },
  { re: /\b5[\s-]?hour(?:ly)?\b[^.\n]{0,20}\blimit\b/i, kind: 'session-5h' },
  { re: /\bweekly\b[^.\n]{0,20}\blimit\b/i, kind: 'weekly' },
  { re: /\b(?:usage|rate)[\s-]?limit\b/i, kind: 'generic' },
  { re: /\bapproaching\b[^.\n]{0,30}\blimit\b/i, kind: 'generic' },
  { re: /\byou(?:'ve|\s+have)?\s+(?:reached|hit)\b[^.\n]{0,24}\blimit\b/i, kind: 'generic' },
  { re: /\blimit\b[^.\n]{0,20}\breset/i, kind: 'generic' },
  { re: /\bNutzungslimit\b/i, kind: 'generic' }
]

/** Room for provider-specific phrasings; the common list already covers most. */
const PROVIDER_PATTERNS: Partial<Record<AgentProviderId, LimitPattern[]>> = {}

export function limitKindLabel(kind: LimitKind): string {
  return LIMIT_KIND_LABELS[kind]
}

export interface LimitMatch {
  kind: LimitKind
  /** The matched phrase, whitespace-collapsed and length-capped. */
  note: string
}

/** Scan text (ANSI tolerated) for a provider usage-limit signal. */
export function detectLimit(provider: AgentProviderId, rawText: string): LimitMatch | null {
  const text = stripAnsi(rawText)
  const patterns = [...(PROVIDER_PATTERNS[provider] ?? []), ...COMMON_PATTERNS]
  for (const { re, kind } of patterns) {
    const m = re.exec(text)
    if (m) {
      return { kind, note: m[0].replace(/\s+/g, ' ').trim().slice(0, 120) }
    }
  }
  return null
}
