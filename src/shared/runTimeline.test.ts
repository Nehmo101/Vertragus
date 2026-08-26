import { describe, expect, it } from 'vitest'
import type { AgentEvent } from './schema/events'
import type { TaskBoardState } from './schema/tasks'
import {
  inspectTimelineSpan,
  projectRunTimeline,
  TIMELINE_CARD_LANE_CAP
} from './runTimeline'

let seq = 0
function event<T extends Omit<AgentEvent, 'seq' | 'ts'> & { ts?: number }>(
  payload: T
): AgentEvent {
  seq += 1
  return { ...payload, seq, ts: payload.ts ?? seq * 1_000 } as unknown as AgentEvent
}

function reset(): void {
  seq = 0
}

const identity = (agentId: string, roleId: string, name = agentId) => ({
  agentId,
  name,
  roleId
})

describe('projectRunTimeline', () => {
  it('lays a flat team on overlapping lanes and never invents tokens', () => {
    reset()
    const events = [
      event({ type: 'agent_started', ...identity('w1', 'worker'), taskSubject: 'Fix parser' }),
      event({ type: 'agent_started', ...identity('r1', 'reviewer'), taskSubject: 'Review parser' }),
      event({
        type: 'agent_done',
        ...identity('w1', 'worker'),
        summary: 'Parser accepts empty input.',
        status: 'success',
        changedFiles: ['src/parse.ts'],
        diffStat: ' src/parse.ts | 4 +'
      }),
      event({
        type: 'agent_done',
        ...identity('r1', 'reviewer'),
        summary: 'Looks good.',
        status: 'success'
      })
    ]
    const timeline = projectRunTimeline({
      workspaceId: 'ws-1',
      meta: { workspaceName: 'Paradiso', goal: 'Fix parser', startedAt: 500 },
      events
    })
    expect(timeline.agentCount).toBe(2)
    expect(timeline.lanes.map((lane) => lane.roleId)).toEqual(['worker', 'reviewer'])
    expect(timeline.lanes[0]!.span).toMatchObject({
      status: 'success',
      summary: 'Parser accepts empty input.',
      hostFacts: { changedFiles: ['src/parse.ts'] }
    })
    expect(timeline.chapters.map((chapter) => chapter.id)).toEqual(['implement', 'review'])
    expect(timeline).not.toHaveProperty('tokens')
    expect(JSON.stringify(timeline)).not.toMatch(/dollar|token/i)
  })

  it('nests helpers under workers under a lead via parentId', () => {
    reset()
    const events = [
      event({ type: 'agent_started', ...identity('lead', 'lead') }),
      event({
        type: 'agent_started',
        ...identity('w1', 'worker'),
        parentId: 'lead',
        taskSubject: 'Slice A'
      }),
      event({
        type: 'agent_started',
        ...identity('h1', 'worker'),
        parentId: 'w1',
        taskSubject: 'Helper grep'
      }),
      event({
        type: 'agent_done',
        ...identity('h1', 'worker'),
        summary: 'Found src/a.ts',
        status: 'success'
      }),
      event({
        type: 'agent_done',
        ...identity('w1', 'worker'),
        summary: 'Slice A landed.',
        status: 'success'
      })
    ]
    const timeline = projectRunTimeline({ workspaceId: 'ws-1', events })
    expect(timeline.lanes.map((lane) => lane.agentId)).toEqual(['lead', 'w1', 'h1'])
    expect(timeline.lanes.map((lane) => lane.depth)).toEqual([0, 1, 2])
    const inspector = inspectTimelineSpan(timeline, events, undefined, 'w1')
    expect(inspector?.children).toEqual([
      { agentId: 'h1', name: 'h1', roleId: 'worker', summary: 'Found src/a.ts' }
    ])
    expect(inspector?.parentName).toBe('lead')
  })

  it('flattens helpers honestly when parentId is missing (pre-A1 journals)', () => {
    reset()
    const events = [
      event({ type: 'agent_started', ...identity('w1', 'worker') }),
      event({ type: 'agent_started', ...identity('h1', 'worker') })
    ]
    const timeline = projectRunTimeline({ workspaceId: 'ws-1', events })
    expect(timeline.lanes.map((lane) => lane.agentId)).toEqual(['w1', 'h1'])
    expect(timeline.lanes.every((lane) => lane.depth === 0)).toBe(true)
    expect(timeline.lanes.every((lane) => lane.parentId === undefined)).toBe(true)
  })

  it('Stop without retro is stopped/user_stop and does not invent success', () => {
    reset()
    const events = [
      event({ type: 'user_question', questionId: 'q1', question: 'Which surface?' }),
      event({ type: 'agent_started', ...identity('w1', 'worker') })
    ]
    const timeline = projectRunTimeline({
      workspaceId: 'ws-1',
      meta: { startedAt: 1_000, endedAt: 5_000, endReason: 'user_stop' },
      events,
      now: 9_000
    })
    expect(timeline.status).toBe('stopped')
    expect(timeline.endReason).toBe('user_stop')
    expect(timeline.lanes[0]!.span.status).toBe('stopped')
    expect(timeline.lanes[0]!.span.summary).toBeUndefined()
    expect(timeline.chapters.some((chapter) => chapter.id === 'intake')).toBe(true)
  })

  it('records PR ok and fail from the event, never a second URL', () => {
    reset()
    const ok = projectRunTimeline({
      workspaceId: 'ws-1',
      events: [
        event({
          type: 'pull_request',
          ok: true,
          branch: 'vertragus/x/orch',
          base: 'main',
          url: 'https://github.com/o/r/pull/9'
        })
      ]
    })
    expect(ok).toMatchObject({ pullRequestUrl: 'https://github.com/o/r/pull/9', pullRequestOk: true })
    expect(ok.chapters.map((chapter) => chapter.id)).toEqual(['pr'])

    reset()
    const fail = projectRunTimeline({
      workspaceId: 'ws-1',
      events: [
        event({
          type: 'pull_request',
          ok: false,
          branch: 'vertragus/x/orch',
          base: 'main',
          message: 'gh is not installed'
        })
      ]
    })
    expect(fail.pullRequestOk).toBe(false)
    expect(fail.pullRequestUrl).toBeUndefined()
  })

  it('intake chapter is scout and questions before the first worker, not after', () => {
    reset()
    const events = [
      event({ type: 'user_question', questionId: 'q1', question: 'AC?' }),
      event({ type: 'agent_started', ...identity('s1', 'scout') }),
      event({
        type: 'agent_done',
        ...identity('s1', 'scout'),
        summary: 'Lives in src/panel.',
        status: 'success'
      }),
      event({ type: 'agent_started', ...identity('w1', 'worker') }),
      event({ type: 'integrate_ok', ...identity('w1', 'worker'), branch: 'b', headSha: 'abc' })
    ]
    const timeline = projectRunTimeline({ workspaceId: 'ws-1', events })
    expect(timeline.chapters.map((chapter) => chapter.id)).toEqual([
      'intake',
      'implement',
      'integrate'
    ])
  })

  it('inspector lists claimed tasks and never invents a success from empty summary', () => {
    reset()
    const events = [event({ type: 'agent_started', ...identity('w1', 'worker') })]
    const tasks: TaskBoardState = {
      schemaVersion: 1,
      nextTaskNumber: 2,
      tasks: [
        {
          taskId: 'task-1',
          revision: 1,
          subject: 'The ask',
          description: 'Where: src/\nDone means: tests pass\nOut of scope: rewrite',
          status: 'in_progress',
          ownerAgentId: 'w1',
          blockedBy: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }
    const timeline = projectRunTimeline({ workspaceId: 'ws-1', events, tasks })
    const inspector = inspectTimelineSpan(timeline, events, tasks, 'w1')
    expect(inspector?.tasks.map((task) => task.taskId)).toEqual(['task-1'])
    expect(inspector?.span.status).toBe('running')
    expect(inspector?.span.summary).toBeUndefined()
  })

  it('exports the card lane cap the UI uses for +N more', () => {
    expect(TIMELINE_CARD_LANE_CAP).toBe(6)
  })
})
