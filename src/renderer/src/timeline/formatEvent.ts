/**
 * How one journal event is painted in the timeline sheet.
 *
 * Labels live in i18n (`timeline.event.<type>`); this module only picks the
 * interpolations and a one-line detail from the payload. The host event type
 * is a closed union — unknown types fall back to the raw `type` string.
 */
import type { AgentEvent } from '@shared/schema/events'
import { formatTokenCount, tokenUsageCount } from '../lib/formatTokens'
import type { Locale, Translate } from '../i18n'

export interface TimelineEventRow {
  seq: number
  ts: number
  label: string
  detail?: string
}

function interpolations(event: AgentEvent): Record<string, string | number> {
  const record = event as unknown as Record<string, unknown>
  const pick = (key: string): string => {
    const value = record[key]
    return typeof value === 'string' ? value : ''
  }
  return {
    name: pick('name'),
    roleId: pick('roleId'),
    summary: pick('summary'),
    message: pick('message'),
    question: pick('question'),
    note: pick('note'),
    text: pick('text'),
    branch: pick('branch'),
    status: pick('status')
  }
}

function detailOf(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'agent_done':
      return [event.snapshotError, event.summary].filter(Boolean).join('\n')
    case 'agent_reseat_failed':
    case 'agent_start_failed':
    case 'orchestrator_handoff_failed':
      return event.message
    case 'agent_question':
    case 'user_question':
      return event.question
    case 'agent_progress':
    case 'agent_stopped':
      return event.note
    case 'agent_reseated':
      return `${event.from.providerId} / ${event.from.model ?? ''} → ${event.to.providerId} / ${event.to.model ?? ''}`
    case 'user_message':
      return event.text
    case 'integrate_conflict':
      return event.message
    case 'pull_request':
      return event.message ?? event.url
    default:
      return undefined
  }
}

export function formatEvent(t: Translate, event: AgentEvent, locale: Locale): TimelineEventRow {
  const extras =
    event.type === 'agent_done' && event.tokenUsage
      ? { tokens: formatTokenCount(tokenUsageCount(event.tokenUsage), locale) }
      : {}
  const key =
    event.type === 'agent_done' && event.tokenUsage
      ? event.tokenUsage.kind === 'context'
        ? 'timeline.event.agent_done_context'
        : 'timeline.event.agent_done_tokens'
      : `timeline.event.${event.type}`
  const label = t([key, event.type], { ...interpolations(event), ...extras })
  const detail = detailOf(event)?.trim()
  return {
    seq: event.seq,
    ts: event.ts,
    label,
    ...(detail ? { detail } : {})
  }
}

/** Snapshot + live may overlap on seq; keep one row per seq, oldest first. */
export function mergeEvents(
  current: readonly AgentEvent[],
  incoming: readonly AgentEvent[]
): AgentEvent[] {
  if (incoming.length === 1 && (current.length === 0 || incoming[0].seq > current[current.length - 1].seq)) {
    return [...current, incoming[0]]
  }
  const bySeq = new Map<number, AgentEvent>()
  for (const event of current) bySeq.set(event.seq, event)
  for (const event of incoming) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

export function formatEventTime(ts: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === 'en' ? 'en' : 'de', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date(ts))
  } catch {
    return String(ts)
  }
}
