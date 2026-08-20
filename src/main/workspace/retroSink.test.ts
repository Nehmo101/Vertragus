import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentEventPayload } from '@shared/schema/events'
import type { ModelLearning, RunRetro } from '@shared/schema/retro'
import { createRetroSink, type RetroStorePort } from './retroSink'
import { testProfile } from './testing'

/** In-memory store port: enough behavior for the sink, none of electron-store. */
function memoryStore(): RetroStorePort & { retros: RunRetro[]; learnings: ModelLearning[] } {
  const state = { retros: [] as RunRetro[], learnings: [] as ModelLearning[] }
  return {
    get retros() {
      return state.retros
    },
    get learnings() {
      return state.learnings
    },
    getRunRetros: () => [...state.retros],
    recordRunRetro: (retro) => {
      state.retros = [retro as RunRetro, ...state.retros.filter((r) => r.id !== (retro as RunRetro).id)]
      return [...state.retros]
    },
    getModelLearnings: () => [...state.learnings],
    setModelLearnings: (learnings) => {
      state.learnings = learnings as ModelLearning[]
      return [...state.learnings]
    }
  }
}

let seq = 0
function event(payload: AgentEventPayload): AgentEvent {
  seq += 1
  return { ...payload, seq, ts: seq * 1_000 }
}

const runEvents: AgentEvent[] = [
  event({
    type: 'agent_started',
    agentId: 'a1',
    name: 'Marco',
    roleId: 'worker',
    providerId: 'claude',
    model: 'sonnet'
  }),
  event({ type: 'agent_done', agentId: 'a1', name: 'Marco', roleId: 'worker', summary: 'ok', status: 'success' }),
  event({ type: 'agent_stopped', agentId: 'a1', name: 'Marco', roleId: 'worker' })
]

describe('recordLearnings', () => {
  it('resolves the role to the slot provider/model and merges into the store', () => {
    const store = memoryStore()
    const sink = createRetroSink({ store, now: () => 1_000 })

    const first = sink.recordLearnings(testProfile(), [
      { role: 'worker', kind: 'strength', insight: 'stark bei UI' }
    ])
    expect(first.applied).toBe(1)
    expect(store.learnings[0]).toMatchObject({
      providerId: 'claude',
      model: 'sonnet',
      roleId: 'worker',
      source: 'orchestrator',
      profileId: 'profile-1',
      observations: 1
    })

    const again = sink.recordLearnings(testProfile(), [
      { role: 'worker', kind: 'strength', insight: 'stark bei UI' }
    ])
    expect(again.applied).toBe(1)
    expect(store.learnings).toHaveLength(1)
    expect(store.learnings[0]!.observations).toBe(2)
  })

  it('prefers an explicit model override over the slot default', () => {
    const store = memoryStore()
    const sink = createRetroSink({ store, now: () => 1_000 })
    sink.recordLearnings(testProfile(), [
      { role: 'worker', model: 'opus', kind: 'weakness', insight: 'teuer für Kleinkram' }
    ])
    expect(store.learnings[0]!.model).toBe('opus')
  })

  it('skips roles the profile has no slot for instead of failing the batch', () => {
    const store = memoryStore()
    const sink = createRetroSink({ store, now: () => 1_000 })
    const result = sink.recordLearnings(testProfile(), [
      { role: 'wizard', kind: 'strength', insight: 'zaubert' },
      { role: 'reviewer', kind: 'strength', insight: 'gründlich' }
    ])
    expect(result.applied).toBe(1)
    expect(store.learnings).toHaveLength(1)
    expect(store.learnings[0]!.roleId).toBe('reviewer')
  })
})

describe('finalizeRun', () => {
  it('persists the folded stats with the summary', () => {
    const store = memoryStore()
    const sink = createRetroSink({ store, now: () => 9_000 })

    const retro = sink.finalizeRun({
      workspaceId: 'ws-1',
      workspaceName: 'Limbo',
      profileId: 'profile-1',
      events: runEvents,
      summary: 'Sauberer Lauf.'
    })

    expect(retro).toBeDefined()
    expect(store.retros).toHaveLength(1)
    expect(store.retros[0]).toMatchObject({
      id: 'retro-ws-1',
      workspaceName: 'Limbo',
      summary: 'Sauberer Lauf.',
      endedAt: 9_000
    })
    expect(store.retros[0]!.stats[0]).toMatchObject({
      roleId: 'worker',
      providerId: 'claude',
      model: 'sonnet',
      started: 1,
      succeeded: 1,
      stopped: 1
    })
  })

  it('skips a run that never started an agent', () => {
    const store = memoryStore()
    const sink = createRetroSink({ store })
    const retro = sink.finalizeRun({
      workspaceId: 'ws-2',
      workspaceName: 'Inferno',
      profileId: 'profile-1',
      events: []
    })
    expect(retro).toBeUndefined()
    expect(store.retros).toHaveLength(0)
  })
})

describe('knowledge', () => {
  it('combines stored learnings and routing scores per profile slot', () => {
    const store = memoryStore()
    const sink = createRetroSink({ store, now: () => 1_000 })
    // Three judged successes reach the routing sample floor.
    const successes = [
      event({ type: 'agent_started', agentId: 'b1', name: 'B', roleId: 'worker', providerId: 'claude', model: 'sonnet' }),
      event({ type: 'agent_done', agentId: 'b1', name: 'B', roleId: 'worker', summary: '1', status: 'success' }),
      event({ type: 'agent_done', agentId: 'b1', name: 'B', roleId: 'worker', summary: '2', status: 'success' }),
      event({ type: 'agent_done', agentId: 'b1', name: 'B', roleId: 'worker', summary: '3', status: 'success' })
    ]
    sink.finalizeRun({
      workspaceId: 'ws-1',
      workspaceName: 'Limbo',
      profileId: 'profile-1',
      events: successes
    })
    sink.recordLearnings(testProfile(), [
      { role: 'worker', kind: 'strength', insight: 'stark bei UI' }
    ])

    const knowledge = sink.knowledge(testProfile())
    // Two entries: the worker slot exactly, and the reviewer slot — its model
    // is the provider default (''), which inherits every claude learning.
    expect(knowledge).toHaveLength(2)
    expect(knowledge[0]).toMatchObject({
      roleId: 'worker',
      providerId: 'claude',
      model: 'sonnet',
      strengths: ['stark bei UI']
    })
    expect(knowledge[0]!.score?.samples).toBe(3)
    expect(knowledge[1]).toMatchObject({ roleId: 'reviewer', model: '' })
    expect(knowledge[1]!.score).toBeUndefined()
  })
})

describe('repo notes — E2 sink', () => {
  it('feeds stored notes into the briefing and records new ones per profile', async () => {
    const { createRetroSink } = await import('./retroSink')
    const notes: Array<{ profileId: string; note: string }> = []
    const sink = createRetroSink({
      store: {
        getRunRetros: () => [],
        recordRunRetro: () => [],
        getModelLearnings: () => [],
        setModelLearnings: () => [],
        getRepoNotes: (profileId) =>
          notes
            .filter((entry) => !profileId || entry.profileId === profileId)
            .map((entry, index) => ({
              id: `n${index}`,
              profileId: entry.profileId,
              note: entry.note,
              createdAt: 1
            })),
        addRepoNotes: (profileId, fresh) => {
          for (const note of fresh) notes.push({ profileId, note })
          return notes.map((entry, index) => ({
            id: `n${index}`,
            profileId: entry.profileId,
            note: entry.note,
            createdAt: 1
          }))
        }
      }
    })
    const profile = {
      id: 'p1',
      slots: []
    } as unknown as import('@shared/schema/profile').Profile

    expect(sink.recordRepoNotes(profile, ['tests need pnpm run ci'])).toEqual({ applied: 1 })
    expect(sink.repoNotes(profile)).toEqual(['tests need pnpm run ci'])
  })

  it('stays a no-op against a store without the repo-note surface', async () => {
    const { createRetroSink } = await import('./retroSink')
    const sink = createRetroSink({
      store: {
        getRunRetros: () => [],
        recordRunRetro: () => [],
        getModelLearnings: () => [],
        setModelLearnings: () => []
      }
    })
    const profile = { id: 'p1', slots: [] } as unknown as import('@shared/schema/profile').Profile
    expect(sink.recordRepoNotes(profile, ['x'])).toEqual({ applied: 0 })
    expect(sink.repoNotes(profile)).toEqual([])
  })
})
