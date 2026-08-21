import { describe, expect, it } from 'vitest'
import { buildHandoffPackage } from '../schema/handoff'
import {
  buildSuccessorOrchestratorSystemPrompt,
  formatHandoffSeed
} from './orchestratorHandoff'

const pkgInput = {
  workspaceId: 'ws',
  workspaceName: 'Paradiso',
  profileId: 'p1',
  createdAt: 1,
  reason: 'context_full' as const,
  predecessor: { agentId: 'o1', name: 'Virgilio', providerId: 'claude' },
  successorAgentId: 'o2',
  eventCursor: 42,
  agents: [{ agentId: 'a1', name: 'Caronte', role: 'worker', status: 'working' }],
  openQuestions: [{ questionId: 'q1', agentId: 'a1', question: 'merge which branch?' }],
  recentEvents: [],
  nextActions: ['Answer Caronte, then inspect the branch']
}
const pkg = buildHandoffPackage(pkgInput)

describe('formatHandoffSeed', () => {
  it('tells the successor the cursor, open questions and that this is a continuation', () => {
    const seed = formatHandoffSeed(pkg)
    expect(seed).toContain('successor of Virgilio')
    expect(seed).toContain('cursor 42')
    expect(seed).toContain('q1')
    expect(seed).toContain('merge which branch?')
    expect(seed).toContain('continuation of the same run')
    expect(seed).toContain('Do not call record_retro until the goal is actually reached')
  })

  it('lists the live team in prose', () => {
    const seed = formatHandoffSeed(
      buildHandoffPackage({
        ...pkgInput,
        agents: [
          {
            agentId: 'a1',
            name: 'Caronte',
            role: 'worker',
            status: 'working',
            branch: 'vertragus/paradiso/caronte',
            pendingQuestionId: 'q1',
            lastSummary: 'Parser half done.',
            orchNote: 'slow but correct'
          }
        ]
      })
    )
    expect(seed).toContain('Your team right now')
    expect(seed).toContain('- Caronte [a1] (worker, working)')
    expect(seed).toContain('branch vertragus/paradiso/caronte')
    expect(seed).toContain('waiting on your answer to question q1')
    expect(seed).toContain('note: slow but correct')
    expect(seed).toContain('last reported: Parser half done.')
  })

  it('says so when no subagents are running', () => {
    const seed = formatHandoffSeed(buildHandoffPackage({ ...pkgInput, agents: [] }))
    expect(seed).toContain('No subagents are running for you right now')
  })

  it('renders decisions, risks, branches, note and the event tail as prose', () => {
    const seed = formatHandoffSeed(
      buildHandoffPackage({
        ...pkgInput,
        decisions: ['Parser stays hand-written'],
        risks: ['Windows path handling untested'],
        branchesOfInterest: ['vertragus/paradiso/caronte'],
        note: 'Minosse is slower than expected.',
        recentEvents: [
          { seq: 40, type: 'agent_done', agentId: 'a1', name: 'Caronte', summary: 'Parser landed' }
        ]
      })
    )
    expect(seed).toContain('Decisions already made')
    expect(seed).toContain('- Parser stays hand-written')
    expect(seed).toContain('Known risks:')
    expect(seed).toContain('- Windows path handling untested')
    expect(seed).toContain('Branches of interest:')
    expect(seed).toContain('- vertragus/paradiso/caronte')
    expect(seed).toContain('#40 agent_done Caronte: Parser landed')
    expect(seed).toContain('Note from your predecessor: Minosse is slower than expected.')
  })

  it('omits empty sections and never dumps the package as JSON', () => {
    const seed = formatHandoffSeed(pkg)
    expect(seed).not.toContain('Decisions already made')
    expect(seed).not.toContain('Known risks')
    expect(seed).not.toContain('Note from your predecessor')
    // The dedupe that matters: no second, JSON-shaped copy of the same facts.
    expect(seed).not.toContain('"eventCursor"')
    expect(seed).not.toContain('"schemaVersion"')
    expect(seed).not.toContain('Full handoff package')
  })

  it('S4: names the task board as host state and renders its rows — omitted when empty', () => {
    const seed = formatHandoffSeed(
      buildHandoffPackage({
        ...pkgInput,
        tasks: [
          {
            taskId: 'task-1',
            revision: 4,
            subject: 'Fix the parser',
            status: 'in_progress',
            ownerAgentId: 'a1',
            blockedBy: []
          },
          { taskId: 'task-2', revision: 1, subject: 'Review it', status: 'pending', blockedBy: ['task-1'] }
        ]
      })
    )
    expect(seed).toContain('task_list shows it; do not rebuild it from prose')
    expect(seed).toContain('- task-1 rev 4 (in_progress, owner a1): Fix the parser')
    expect(seed).toContain('- task-2 rev 1 (pending, blockedBy task-1): Review it')
    // A run without a board keeps the seed clean.
    expect(formatHandoffSeed(pkg)).not.toContain('task board')
  })

  it('keeps only the tail of recentEvents', () => {
    const seed = formatHandoffSeed(
      buildHandoffPackage({
        ...pkgInput,
        recentEvents: Array.from({ length: 25 }, (_, i) => ({
          seq: i + 1,
          type: 'agent_done',
          agentId: 'a1',
          summary: `step ${i + 1}`
        }))
      })
    )
    expect(seed).toContain('#25 agent_done a1: step 25')
    expect(seed).toContain('#16 agent_done a1: step 16')
    expect(seed).not.toContain('#15 agent_done a1: step 15')
  })
})

describe('buildSuccessorOrchestratorSystemPrompt', () => {
  it('keeps the loop rules and appends the package', () => {
    const prompt = buildSuccessorOrchestratorSystemPrompt(
      {
        workspaceName: 'Paradiso',
        repoPath: '/repo',
        rolesWithLimits: [{ id: 'worker' }]
      },
      pkg
    )
    expect(prompt).toContain('You are the orchestrator of the Vertragus workspace')
    expect(prompt).toContain('request_succession')
    expect(prompt).toContain('cursor 42')
  })
})
