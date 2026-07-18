import { describe, expect, it, vi } from 'vitest'
import type { OrchestratorSnapshot, WorkspaceSessionSummary } from '@shared/orchestrator'
import {
  executeTool,
  levenshtein,
  normalizeName,
  parseToolArguments,
  resolveProfile,
  type AssistantProfile,
  type VoiceAssistantDeps
} from '@main/voice/assistantTools'

const PROFILES: AssistantProfile[] = [
  { id: 'p1', name: 'Vertragus' },
  { id: 'p2', name: 'Café Landau' },
  { id: 'p3', name: 'Backend Crew' },
  { id: 'p4', name: 'Backend Crew 2' },
  { id: 'p5', name: 'Bäcker' }
]

function makeDeps(overrides: Partial<VoiceAssistantDeps> = {}): VoiceAssistantDeps {
  return {
    listProfiles: () => PROFILES,
    listSessions: () => [],
    listAgents: () => [],
    snapshotForSession: () => undefined,
    startProfileWorkspace: vi.fn(async () => ({
      ok: true,
      sessionId: 'sess-1',
      orchestratorId: 'orch-1',
      agentCount: 3,
      goalSeeded: false
    })),
    seedToOrchestrator: vi.fn(async () => true),
    stopAgents: vi.fn(async () => 4),
    ...overrides
  }
}

function session(partial: Partial<WorkspaceSessionSummary>): WorkspaceSessionSummary {
  return {
    id: 'sess-1',
    profileId: 'p1',
    profileName: 'Vertragus',
    sequence: 1,
    name: 'Rivendell',
    taskSummary: undefined,
    startedAt: 1,
    active: true,
    ...partial
  }
}

describe('normalizeName / levenshtein', () => {
  it('deburrs umlauts and ß', () => {
    expect(normalizeName('Bäcker')).toBe('backer')
    expect(normalizeName('Straße')).toBe('strasse')
    expect(normalizeName('Café Landau')).toBe('cafelandau')
  })

  it('folds ae/oe/ue digraphs consistently', () => {
    expect(normalizeName('Baecker')).toBe(normalizeName('Bäcker'))
    expect(normalizeName('Björn')).toBe(normalizeName('Bjoern'))
  })

  it('computes edit distance', () => {
    expect(levenshtein('vertragus', 'vertragus')).toBe(0)
    expect(levenshtein('vertragus', 'vertragis')).toBe(1)
    expect(levenshtein('abc', 'xyz')).toBe(3)
  })
})

describe('resolveProfile', () => {
  it('matches exact names', () => {
    expect(resolveProfile('Vertragus', PROFILES)).toEqual({ status: 'ok', profile: PROFILES[0] })
  })

  it('matches despite missing umlauts', () => {
    expect(resolveProfile('cafe landau', PROFILES)).toEqual({ status: 'ok', profile: PROFILES[1] })
    expect(resolveProfile('Baecker', PROFILES)).toEqual({ status: 'ok', profile: PROFILES[4] })
  })

  it('tolerates small typos via Levenshtein', () => {
    expect(resolveProfile('Vertragis', PROFILES)).toEqual({ status: 'ok', profile: PROFILES[0] })
  })

  it('rejects fuzzy matches beyond the Levenshtein≤2 tolerance (negative)', () => {
    // "Vertragus" → distance 3+ must not resolve; a one-edit typo still resolves.
    expect(resolveProfile('Vertxxxgus', PROFILES)).toEqual({ status: 'none' })
    expect(resolveProfile('Vertragis', PROFILES)).toEqual({ status: 'ok', profile: PROFILES[0] })
  })

  it('reports ambiguous matches', () => {
    const result = resolveProfile('Backend', PROFILES)
    expect(result.status).toBe('ambiguous')
    if (result.status === 'ambiguous') {
      expect(result.options.map((o) => o.id).sort()).toEqual(['p3', 'p4'])
    }
  })

  it('returns none for unknown names and empty queries', () => {
    expect(resolveProfile('Zebra Xylophon', PROFILES)).toEqual({ status: 'none' })
    expect(resolveProfile('   ', PROFILES)).toEqual({ status: 'none' })
    expect(resolveProfile('Vertragus', [])).toEqual({ status: 'none' })
  })
})

describe('parseToolArguments', () => {
  it('parses valid JSON objects', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 })
  })
  it('returns {} for malformed or non-object JSON', () => {
    expect(parseToolArguments('not json')).toEqual({})
    expect(parseToolArguments('[1,2]')).toEqual({})
    expect(parseToolArguments('')).toEqual({})
  })
})

describe('executeTool: start_profile_workspace', () => {
  it('starts the resolved profile and records an action', async () => {
    const deps = makeDeps()
    const out = await executeTool(
      'start_profile_workspace',
      { profileName: 'vertragus', goal: 'Baue Feature X' },
      { deps }
    )
    expect(deps.startProfileWorkspace).toHaveBeenCalledWith({ profileId: 'p1', goal: 'Baue Feature X' })
    expect(out.action?.ok).toBe(true)
    expect(out.result.ok).toBe(true)
  })

  it('asks for clarification on ambiguous names without starting anything', async () => {
    const deps = makeDeps()
    const out = await executeTool('start_profile_workspace', { profileName: 'Backend' }, { deps })
    expect(deps.startProfileWorkspace).not.toHaveBeenCalled()
    expect(out.result.needsClarification).toBe(true)
    expect(out.result.options).toEqual(['Backend Crew', 'Backend Crew 2'])
  })

  it('reports unknown profiles', async () => {
    const deps = makeDeps()
    const out = await executeTool('start_profile_workspace', { profileName: 'Zebra' }, { deps })
    expect(deps.startProfileWorkspace).not.toHaveBeenCalled()
    expect(out.result.ok).toBe(false)
  })
})

describe('executeTool: send_to_orchestrator', () => {
  it('seeds the active session orchestrator', async () => {
    const deps = makeDeps({ listSessions: () => [session({})] })
    const out = await executeTool('send_to_orchestrator', { text: 'Status bitte' }, { deps })
    expect(deps.seedToOrchestrator).toHaveBeenCalledWith('sess-1', 'Status bitte')
    expect(out.result.ok).toBe(true)
  })

  it('reports no_session when nothing is running', async () => {
    const deps = makeDeps({ listSessions: () => [] })
    const out = await executeTool('send_to_orchestrator', { text: 'Hallo' }, { deps })
    expect(deps.seedToOrchestrator).not.toHaveBeenCalled()
    expect(out.result.reason).toBe('no_session')
  })

  it('rejects empty text', async () => {
    const deps = makeDeps({ listSessions: () => [session({})] })
    const out = await executeTool('send_to_orchestrator', { text: '   ' }, { deps })
    expect(deps.seedToOrchestrator).not.toHaveBeenCalled()
    expect(out.result.ok).toBe(false)
  })

  it('reports no_orchestrator when seeding finds none', async () => {
    const deps = makeDeps({
      listSessions: () => [session({})],
      seedToOrchestrator: vi.fn(async () => false)
    })
    const out = await executeTool('send_to_orchestrator', { text: 'Hi' }, { deps })
    expect(out.result.reason).toBe('no_orchestrator')
  })
})

describe('executeTool: get_status', () => {
  it('projects a compact snapshot for the active session', async () => {
    const snapshot: OrchestratorSnapshot = {
      goal: { id: 'g', title: 'Mein Ziel', active: true },
      tasks: [
        { id: 't1', title: 'Task A', role: 'be', status: 'running', phase: 'working', lastAction: 'edit', createdAt: 1 }
      ],
      activity: { phase: 'monitoring', summary: 'Arbeitet', details: [], updatedAt: 1 },
      findings: [{ id: 'f1', taskId: 't1', kind: 'insight', title: 'Wichtig', detail: 'x', createdAt: 1 }]
    }
    const deps = makeDeps({
      listSessions: () => [session({})],
      snapshotForSession: () => snapshot
    })
    const out = await executeTool('get_status', {}, { deps })
    const status = out.result.status as Record<string, unknown>
    expect(out.result.running).toBe(true)
    expect(status.goal).toBe('Mein Ziel')
    expect((status.findings as string[])).toEqual(['Wichtig'])
  })

  it('reports no running session gracefully', async () => {
    const deps = makeDeps({ listSessions: () => [] })
    const out = await executeTool('get_status', {}, { deps })
    expect(out.result.running).toBe(false)
    expect(out.result.ok).toBe(true)
  })
})

describe('executeTool: switch_layout / open_view', () => {
  it('emits a UI command for a valid layout', async () => {
    const out = await executeTool('switch_layout', { layout: 'canvas' }, { deps: makeDeps() })
    expect(out.uiCommand).toEqual({ kind: 'switch_layout', layout: 'canvas' })
  })

  it('rejects an unknown layout', async () => {
    const out = await executeTool('switch_layout', { layout: 'spaceship' }, { deps: makeDeps() })
    expect(out.uiCommand).toBeUndefined()
    expect(out.result.ok).toBe(false)
  })

  it('emits a UI command for a view', async () => {
    const out = await executeTool('open_view', { view: 'inbox' }, { deps: makeDeps() })
    expect(out.uiCommand).toEqual({ kind: 'open_view', view: 'inbox' })
  })

  it('rejects an empty view', async () => {
    const out = await executeTool('open_view', { view: '' }, { deps: makeDeps() })
    expect(out.uiCommand).toBeUndefined()
    expect(out.result.ok).toBe(false)
  })
})

describe('executeTool: stop_agents (confirmation gating, D9)', () => {
  it('requires confirmation before stopping', async () => {
    const deps = makeDeps()
    const out = await executeTool('stop_agents', {}, { deps })
    expect(deps.stopAgents).not.toHaveBeenCalled()
    expect(out.result.needsConfirmation).toBe(true)
    expect(out.confirmation?.args).toEqual({ profileName: undefined, confirmed: true })
  })

  it('stops all agents once confirmed', async () => {
    const deps = makeDeps()
    const out = await executeTool('stop_agents', { confirmed: true }, { deps })
    expect(deps.stopAgents).toHaveBeenCalledWith(undefined)
    expect(out.result).toEqual({ ok: true, stopped: 4 })
  })

  it('scopes to a resolved profile when confirmed', async () => {
    const deps = makeDeps()
    await executeTool('stop_agents', { profileName: 'vertragus', confirmed: true }, { deps })
    expect(deps.stopAgents).toHaveBeenCalledWith('p1')
  })

  it('asks for clarification on ambiguous profile even with confirmed', async () => {
    const deps = makeDeps()
    const out = await executeTool('stop_agents', { profileName: 'Backend', confirmed: true }, { deps })
    expect(deps.stopAgents).not.toHaveBeenCalled()
    expect(out.result.needsClarification).toBe(true)
  })
})

describe('executeTool: unknown tool', () => {
  it('returns an error payload instead of throwing', async () => {
    const out = await executeTool('does_not_exist', {}, { deps: makeDeps() })
    expect(out.result.ok).toBe(false)
    expect(out.action?.ok).toBe(false)
  })
})
