/**
 * Presentation for archive rows and timeline chrome — unit-testable without a DOM.
 */
import type { RunListEntry } from '@shared/schema/runArchive'
import type { RunTimeline, TimelineChapterId, TimelineSpanStatus } from '@shared/runTimeline'
import { TIMELINE_CARD_LANE_CAP } from '@shared/runTimeline'
import type { Translate } from '../i18n'

export function archiveStatusLabel(t: Translate, row: RunListEntry, live: boolean): string {
  if (live || row.status === 'running') return t('panel.archiveRunning')
  if (row.endReason === 'retro') return t('panel.archiveEndedRetro')
  if (row.endReason === 'crash') return t('panel.archiveEndedCrash')
  if (row.endReason === 'user_stop') return t('panel.archiveEndedUserStop')
  return t('panel.archiveEndedUnknown')
}

export function archiveDurationLabel(t: Translate, durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || durationMs < 0) return undefined
  const minutes = Math.max(1, Math.round(durationMs / 60_000))
  return t('panel.archiveDuration', { minutes })
}

export function archiveGoalLine(row: RunListEntry): string {
  return row.goal?.trim() || row.workspaceName || row.workspaceId
}

export function timelineChapterLabel(t: Translate, id: TimelineChapterId): string {
  if (id === 'intake') return t('panel.timelineChapterIntake')
  if (id === 'implement') return t('panel.timelineChapterImplement')
  if (id === 'review') return t('panel.timelineChapterReview')
  if (id === 'integrate') return t('panel.timelineChapterIntegrate')
  return t('panel.timelineChapterPr')
}

export function timelineSpanStatusLabel(t: Translate, status: TimelineSpanStatus): string {
  if (status === 'success') return t('panel.timelineStatusSuccess')
  if (status === 'failed') return t('panel.timelineStatusFailed')
  if (status === 'blocked') return t('panel.timelineStatusBlocked')
  if (status === 'running') return t('panel.timelineStatusRunning')
  if (status === 'stopped') return t('panel.timelineStatusStopped')
  return t('panel.timelineStatusUnknown')
}

export function timelineOverflowLabel(t: Translate, laneCount: number): string | undefined {
  if (laneCount <= TIMELINE_CARD_LANE_CAP) return undefined
  return t('panel.timelineMore', { count: laneCount - TIMELINE_CARD_LANE_CAP })
}

export function visibleTimelineLanes<T>(lanes: readonly T[]): readonly T[] {
  return lanes.slice(0, TIMELINE_CARD_LANE_CAP)
}

export function spanStyle(startedAt: number, endedAt: number, t0: number, t1: number): {
  left: string
  width: string
} {
  const range = Math.max(1, t1 - t0)
  const left = Math.max(0, ((startedAt - t0) / range) * 100)
  const width = Math.max(1.5, ((endedAt - startedAt) / range) * 100)
  return { left: `${left}%`, width: `${Math.min(100 - left, width)}%` }
}

export function timelineHeaderStatus(t: Translate, timeline: RunTimeline, live: boolean): string {
  if (live || timeline.status === 'running') return t('panel.timelineRunning')
  if (timeline.endReason === 'user_stop') return t('panel.timelineStoppedByUser')
  return t('panel.timelineStopped')
}
