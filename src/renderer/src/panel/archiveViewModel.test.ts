import { describe, expect, it } from 'vitest'
import { translator } from '../i18n'
import type { RunListEntry } from '@shared/schema/runArchive'
import {
  archiveDurationLabel,
  archiveGoalLine,
  archiveStatusLabel,
  spanStyle,
  timelineOverflowLabel,
  visibleTimelineLanes
} from './archiveViewModel'
import { TIMELINE_CARD_LANE_CAP } from '@shared/runTimeline'

const t = translator('en')

const row = (over: Partial<RunListEntry> = {}): RunListEntry => ({
  workspaceId: 'ws-1',
  status: 'stopped',
  ...over
})

describe('archiveViewModel', () => {
  it('labels live rows as running even when the journal already ended', () => {
    expect(archiveStatusLabel(t, row({ status: 'stopped', endReason: 'user_stop' }), true)).toBe(
      'Running'
    )
    expect(archiveStatusLabel(t, row({ status: 'stopped', endReason: 'user_stop' }), false)).toBe(
      'Stopped by the user'
    )
    expect(archiveStatusLabel(t, row({ status: 'stopped', endReason: 'retro' }), false)).toBe(
      'Finished with retro'
    )
  })

  it('falls back to the workspace name then the id', () => {
    expect(archiveGoalLine(row({ goal: 'Fix parser' }))).toBe('Fix parser')
    expect(archiveGoalLine(row({ workspaceName: 'Paradiso' }))).toBe('Paradiso')
    expect(archiveGoalLine(row())).toBe('ws-1')
  })

  it('caps visible lanes and names the overflow', () => {
    const lanes = Array.from({ length: TIMELINE_CARD_LANE_CAP + 2 }, (_, i) => i)
    expect(visibleTimelineLanes(lanes)).toHaveLength(TIMELINE_CARD_LANE_CAP)
    expect(timelineOverflowLabel(t, lanes.length)).toMatch(/\+2/)
    expect(timelineOverflowLabel(t, 3)).toBeUndefined()
  })

  it('places a span as a percentage of the window', () => {
    expect(spanStyle(20, 60, 0, 100)).toEqual({ left: '20%', width: '40%' })
  })

  it('rounds duration up to whole minutes', () => {
    expect(archiveDurationLabel(t, 30_000)).toMatch(/1/)
    expect(archiveDurationLabel(t, undefined)).toBeUndefined()
  })
})
