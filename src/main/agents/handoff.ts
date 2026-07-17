/**
 * Pure composition of an agent-handoff briefing.
 *
 * When a source agent (e.g. "Virgilio") hits a usage limit, its live work is
 * handed to a fresh agent (e.g. "Ulisse"). The briefing is a Markdown note that
 * tells the new agent what the task is, what already happened, and to continue
 * exactly where the source left off. It embeds a bounded, ANSI-stripped tail of
 * the source's terminal scrollback as the record of "how far it got".
 *
 * This module is intentionally side-effect free (no fs / electron) so it can be
 * unit-tested; AgentManager persists the result to disk and seeds the new agent.
 */
import type { AgentInstanceInfo } from '@shared/agents'
import { limitKindLabel, stripAnsi } from '@main/agents/limitSignals'

export const DEFAULT_HANDOFF_SCROLLBACK_CHARS = 24_000

export interface BriefingInput {
  source: AgentInstanceInfo
  /** Name of the taking-over agent (e.g. "Ulisse"). */
  targetName: string
  /** The task the new agent should continue (may be empty). */
  task?: string
  /** Optional free-text note on current state / what's done. */
  summary?: string
  /** Raw scrollback of the source agent (ANSI tolerated). */
  scrollback: string
  /** Max chars of scrollback tail to embed (default DEFAULT_HANDOFF_SCROLLBACK_CHARS). */
  scrollbackChars?: number
  /** Epoch ms stamped into the briefing (injected for deterministic tests). */
  timestamp: number
}

/** Keep the last `maxChars` of ANSI-stripped scrollback; mark if truncated. */
export function tailScrollback(scrollback: string, maxChars: number): string {
  const clean = stripAnsi(scrollback)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trimEnd()
  if (clean.length <= maxChars) return clean
  return `...(gekürzt)...\n${clean.slice(-maxChars)}`
}

function orEmptyNote(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : fallback
}

/** Build the Markdown handoff briefing for the new agent to read. */
export function buildBriefing(input: BriefingInput): string {
  const { source, targetName, task, summary, timestamp } = input
  const maxChars = input.scrollbackChars ?? DEFAULT_HANDOFF_SCROLLBACK_CHARS
  const reason = source.limitWarning
    ? `Limit erreicht/nahe (${limitKindLabel(source.limitWarning.kind)})`
    : 'manuelle Übergabe'
  const tail = tailScrollback(input.scrollback, maxChars)
  const model = source.model || 'CLI-Standard'
  const wd = source.worktree
    ? `${source.workingDir} (Worktree: ${source.worktree})`
    : source.workingDir

  return [
    '# Vertragus — Agent-Übergabe',
    '',
    `- **Von:** ${source.name} (${source.provider}/${model}) — Rolle: ${source.role}`,
    `- **An:** ${targetName}`,
    `- **Grund:** ${reason}`,
    `- **Arbeitsverzeichnis:** ${wd}`,
    `- **Zeit:** ${new Date(timestamp).toISOString()}`,
    '',
    '## Aufgabe',
    orEmptyNote(
      task,
      '_Keine explizite Aufgabe angegeben — bitte aus dem Verlauf unten ableiten._'
    ),
    '',
    '## Bisheriger Stand',
    orEmptyNote(
      summary,
      `_Kein manueller Vermerk. Der bisherige Verlauf von ${source.name} steht unten._`
    ),
    '',
    '## Deine Anweisung',
    `Du übernimmst die Arbeit von ${source.name}. Mach **genau dort weiter**, wo ${source.name} aufgehört hat.`,
    'Lies den Terminal-Verlauf unten, um den letzten Stand zu verstehen. Wiederhole keine bereits erledigten Schritte.',
    'Wenn etwas unklar ist, fasse zuerst kurz zusammen, was du als Nächstes tun willst.',
    '',
    `## Terminal-Verlauf von ${source.name} (Auszug, Ende = neuester Stand)`,
    '```',
    tail || '(kein Verlauf erfasst)',
    '```',
    ''
  ].join('\n')
}
