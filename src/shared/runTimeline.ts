/**
 * T1: pure journal → timeline view model.
 *
 * Same function for a live workspace card and for an archived run. Host truth
 * only: timestamps from events, duration from ts, PR from the pull_request
 * event or meta. Never invents tokens, dollars, or a success the journal
 * did not record.
 */
import { roleColor } from './prompts/roles'
import { isAgentEvent, type AgentEvent, type JsonValue } from './schema/events'
import type { RunEndReason } from './schema/runArchive'
import type { Task, TaskBoardState } from './schema/tasks'

export const TIMELINE_CHAPTER_IDS = ['intake', 'implement', 'review', 'integrate', 'pr'] as const
export type TimelineChapterId = (typeof TIMELINE_CHAPTER_IDS)[number]

export type TimelineSpanStatus =
  | 'running'
  | 'success'
  | 'blocked'
  | 'failed'
  | 'stopped'
  | 'exited'

const IMPLEMENT_ROLES = new Set(['worker', 'janitor', 'docs', 'architect', 'lead'])
const REVIEW_ROLES = new Set(['reviewer', 'tester'])
const INTAKE_ROLES = new Set(['scout'])

export interface TimelineSpan {
  agentId: string
  name: string
  roleId: string
  roleColor: string
  parentId?: string
  taskSubject?: string
  startedAt: number
  endedAt?: number
  status: TimelineSpanStatus
  summary?: string
  result?: JsonValue
  hostFacts?: { branch?: string; diffStat?: string; changedFiles?: string[] }
}

export interface TimelineLane {
  agentId: string
  name: string
  roleId: string
  roleColor: string
  parentId?: string
  depth: number
  span: TimelineSpan
}

export interface TimelineChapter {
  id: TimelineChapterId
  startedAt: number
  endedAt?: number
}

export interface TimelineInspector {
  span: TimelineSpan
  parentName?: string
  children: Array<{ agentId: string; name: string; roleId: string; summary?: string }>
  events: AgentEvent[]
  tasks: Task[]
}

export interface RunTimeline {
  workspaceId: string
  workspaceName?: string
  goal?: string
  startedAt: number
  endedAt?: number
  endReason?: RunEndReason
  durationMs: number
  agentCount: number
  pullRequestUrl?: string
  pullRequestOk?: boolean
  status: 'running' | 'stopped'
  verdict?: string
  lanes: TimelineLane[]
  chapters: TimelineChapter[]
  t0: number
  t1: number
}

export interface ProjectRunTimelineInput {
  workspaceId: string
  meta?: {
    workspaceName?: string
    goal?: string
    startedAt?: number
    endedAt?: number
    endReason?: RunEndReason
    pullRequestUrl?: string
  }
  events: readonly AgentEvent[]
  tasks?: TaskBoardState
  /** Orchestrator `record_retro` summary when the panel already has it. */
  verdict?: string
  /** Wall clock for a still-running span; tests pass a fixed now. */
  now?: number
}

function orderByParent<T extends { agentId: string; parentId?: string }>(items: T[]): T[] {
  const byParent = new Map<string | undefined, T[]>()
  for (const item of items) {
    const key = item.parentId
    const bucket = byParent.get(key) ?? []
    bucket.push(item)
    byParent.set(key, bucket)
  }
  const ordered: T[] = []
  const seen = new Set<string>()
  const walk = (parentId: string | undefined): void => {
    for (const child of byParent.get(parentId) ?? []) {
      if (seen.has(child.agentId)) continue
      ordered.push(child)
      seen.add(child.agentId)
      walk(child.agentId)
    }
  }
  walk(undefined)
  for (const item of items) if (!seen.has(item.agentId)) ordered.push(item)
  return ordered
}

function depths(lanes: Array<{ agentId: string; parentId?: string }>): Map<string, number> {
  const byId = new Map(lanes.map((lane) => [lane.agentId, lane]))
  const memo = new Map<string, number>()
  const depthOf = (id: string, stack: Set<string>): number => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (stack.has(id)) return 0
    const parent = byId.get(id)?.parentId
    if (!parent || !byId.has(parent)) {
      memo.set(id, 0)
      return 0
    }
    stack.add(id)
    const next = depthOf(parent, stack) + 1
    stack.delete(id)
    memo.set(id, next)
    return next
  }
  for (const lane of lanes) depthOf(lane.agentId, new Set())
  return memo
}

function chapterRange(
  id: TimelineChapterId,
  times: number[]
): TimelineChapter | undefined {
  if (times.length === 0) return undefined
  return { id, startedAt: Math.min(...times), endedAt: Math.max(...times) }
}

function fallbackSummary(span: TimelineSpan): string | undefined {
  if (span.summary?.trim()) return span.summary.trim()
  const files = span.hostFacts?.changedFiles
  if (files && files.length > 0) return `${span.roleId}: ${files.slice(0, 3).join(', ')}`
  return undefined
}

/**
 * Project a journal (live or archived) into lanes, spans, chapters and metrics.
 */
export function projectRunTimeline(input: ProjectRunTimelineInput): RunTimeline {
  const now = input.now ?? Date.now()
  const events = input.events
  const lastTs = events.reduce((max, event) => (event.ts > max ? event.ts : max), 0)
  const startedAt = input.meta?.startedAt ?? events[0]?.ts ?? now
  const crashed = events.some((event) => event.type === 'orchestrator_exited')
  const endedAt = input.meta?.endedAt ?? (crashed ? lastTs || undefined : undefined)
  const t1 = endedAt ?? lastTs ?? now
  const t0 = startedAt

  const spans = new Map<string, TimelineSpan>()
  for (const event of events) {
    if (isAgentEvent(event, 'agent_started')) {
      spans.set(event.agentId, {
        agentId: event.agentId,
        name: event.name,
        roleId: event.roleId,
        roleColor: roleColor(event.roleId),
        ...(event.parentId ? { parentId: event.parentId } : {}),
        ...(event.taskSubject ? { taskSubject: event.taskSubject } : {}),
        startedAt: event.ts,
        status: 'running'
      })
      continue
    }
    const span = 'agentId' in event ? spans.get(event.agentId) : undefined
    if (!span) continue
    if (isAgentEvent(event, 'agent_done')) {
      span.endedAt = event.ts
      span.status = event.status
      span.summary = event.summary
      if (event.result !== undefined) span.result = event.result
      const facts = {
        ...(event.branch ? { branch: event.branch } : {}),
        ...(event.diffStat ? { diffStat: event.diffStat } : {}),
        ...(event.changedFiles ? { changedFiles: event.changedFiles } : {})
      }
      if (Object.keys(facts).length > 0) span.hostFacts = facts
    } else if (isAgentEvent(event, 'agent_stopped')) {
      span.endedAt = event.ts
      if (span.status === 'running') span.status = 'stopped'
    } else if (isAgentEvent(event, 'agent_exited')) {
      span.endedAt = event.ts
      if (span.status === 'running') span.status = 'exited'
    }
  }

  for (const span of spans.values()) {
    if (span.status === 'running' && endedAt !== undefined) {
      span.endedAt = endedAt
      span.status = 'stopped'
    }
    const distilled = fallbackSummary(span)
    if (distilled) span.summary = distilled
  }

  const ordered = orderByParent([...spans.values()])
  const depthMap = depths(ordered)
  const lanes: TimelineLane[] = ordered.map((span) => ({
    agentId: span.agentId,
    name: span.name,
    roleId: span.roleId,
    roleColor: span.roleColor,
    ...(span.parentId ? { parentId: span.parentId } : {}),
    depth: depthMap.get(span.agentId) ?? 0,
    span
  }))

  const firstTeam = events.find(
    (event) =>
      isAgentEvent(event, 'agent_started') &&
      !INTAKE_ROLES.has(event.roleId) &&
      event.roleId !== 'orchestrator'
  )
  const intakeTimes = events
    .filter(
      (event) =>
        event.type === 'user_question' ||
        (isAgentEvent(event, 'agent_started') && INTAKE_ROLES.has(event.roleId))
    )
    .filter((event) => !firstTeam || event.ts <= firstTeam.ts)
    .map((event) => event.ts)
  const implementTimes = events
    .filter((event) => isAgentEvent(event, 'agent_started') && IMPLEMENT_ROLES.has(event.roleId))
    .map((event) => event.ts)
  const reviewTimes = events
    .filter((event) => isAgentEvent(event, 'agent_started') && REVIEW_ROLES.has(event.roleId))
    .map((event) => event.ts)
  const integrateTimes = events
    .filter((event) => event.type === 'integrate_ok' || event.type === 'integrate_conflict')
    .map((event) => event.ts)
  const prTimes = events.filter((event) => event.type === 'pull_request').map((event) => event.ts)

  const chapters = (
    [
      chapterRange('intake', intakeTimes),
      chapterRange('implement', implementTimes),
      chapterRange('review', reviewTimes),
      chapterRange('integrate', integrateTimes),
      chapterRange('pr', prTimes)
    ] as Array<TimelineChapter | undefined>
  ).filter((chapter): chapter is TimelineChapter => chapter !== undefined)

  const prEvent = [...events].reverse().find((event) => event.type === 'pull_request')
  const pullRequestUrl =
    input.meta?.pullRequestUrl ??
    (prEvent && prEvent.type === 'pull_request' ? prEvent.url : undefined)
  const pullRequestOk = prEvent && prEvent.type === 'pull_request' ? prEvent.ok : undefined

  const durationEnd = endedAt ?? lastTs ?? now
  const verdict =
    input.verdict?.trim() ||
    (input.meta?.endReason === 'user_stop' ? undefined : undefined)

  return {
    workspaceId: input.workspaceId,
    ...(input.meta?.workspaceName ? { workspaceName: input.meta.workspaceName } : {}),
    ...(input.meta?.goal ? { goal: input.meta.goal } : {}),
    startedAt: t0,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(input.meta?.endReason ? { endReason: input.meta.endReason } : crashed ? { endReason: 'crash' } : {}),
    durationMs: Math.max(0, durationEnd - t0),
    agentCount: spans.size,
    ...(pullRequestUrl ? { pullRequestUrl } : {}),
    ...(pullRequestOk !== undefined ? { pullRequestOk } : {}),
    status: endedAt !== undefined ? 'stopped' : 'running',
    ...(verdict ? { verdict } : {}),
    lanes,
    chapters,
    t0,
    t1: Math.max(t1, t0)
  }
}

/** Events and tasks that belong to one span (inclusive range). */
export function inspectTimelineSpan(
  timeline: RunTimeline,
  events: readonly AgentEvent[],
  tasks: TaskBoardState | undefined,
  agentId: string
): TimelineInspector | undefined {
  const lane = timeline.lanes.find((entry) => entry.agentId === agentId)
  if (!lane) return undefined
  const span = lane.span
  const end = span.endedAt ?? timeline.t1
  const parent = span.parentId
    ? timeline.lanes.find((entry) => entry.agentId === span.parentId)
    : undefined
  const children = timeline.lanes
    .filter((entry) => entry.parentId === agentId)
    .map((entry) => ({
      agentId: entry.agentId,
      name: entry.name,
      roleId: entry.roleId,
      ...(entry.span.summary ? { summary: entry.span.summary } : {})
    }))
  const inRange = events.filter((event) => {
    if (event.ts < span.startedAt || event.ts > end) return false
    if ('agentId' in event) return event.agentId === agentId
    return true
  })
  const claimed = (tasks?.tasks ?? []).filter(
    (task) => task.ownerAgentId === agentId && task.status !== 'deleted'
  )
  return {
    span,
    ...(parent ? { parentName: parent.name } : {}),
    children,
    events: inRange,
    tasks: claimed
  }
}

export const TIMELINE_CARD_LANE_CAP = 6
