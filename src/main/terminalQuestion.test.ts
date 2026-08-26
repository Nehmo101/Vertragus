import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  authorizeCliAnswer,
  cliQuestionContext,
  inboxForCliWindow,
  sameQuestionInbox,
  USER_QUESTION_AGENT_ID,
  type CliQuestionContext,
  type CliQuestionWorkspace
} from './terminalQuestion'

function agent(
  overrides: Partial<CliQuestionWorkspace['agents'][number]> = {}
): CliQuestionWorkspace['agents'][number] {
  return {
    agentId: 'worker-a',
    name: 'Caronte',
    roleId: 'worker',
    ...overrides
  }
}

function workspace(overrides: Partial<CliQuestionWorkspace> = {}): CliQuestionWorkspace {
  return {
    workspaceId: 'ws-1',
    agents: [
      agent({ agentId: 'orch-1', name: 'Virgilio', roleId: 'orchestrator' }),
      agent()
    ],
    ...overrides
  }
}

function ctx(overrides: Partial<CliQuestionContext> = {}): CliQuestionContext {
  const base = cliQuestionContext('orch-1', [workspace()])
  if (!base) throw new Error('expected a context')
  return { ...base, ...overrides }
}

describe('the reserved ask_user addressee', () => {
  it('is the same string the host registry answers under', () => {
    const source = readFileSync(join(__dirname, 'mcp/types.ts'), 'utf8')
    const declaration = /export const USER_QUESTION_AGENT_ID = '([^']+)'/.exec(source)
    expect(declaration, 'USER_QUESTION_AGENT_ID not found in mcp/types.ts').not.toBeNull()
    expect(USER_QUESTION_AGENT_ID).toBe(declaration?.[1])
    // Self-check: a regex that stopped matching would green this with undefined.
    expect(source).toContain("export const USER_QUESTION_AGENT_ID = 'user'")
  })
})

describe('cliQuestionContext', () => {
  it('returns null when the sender belongs to no workspace', () => {
    expect(cliQuestionContext('ghost', [workspace()])).toBeNull()
  })

  it('puts ask_user first, then each agent row that has a pending question', () => {
    const result = cliQuestionContext('orch-1', [
      workspace({
        userQuestion: { questionId: 'q-u', question: '  Ship it?\n' },
        agents: [
          agent({ agentId: 'orch-1', name: 'Virgilio', roleId: 'orchestrator' }),
          agent({
            pendingQuestion: ' Use bcrypt? ',
            pendingQuestionId: 'q-a'
          }),
          agent({
            agentId: 'worker-b',
            name: 'Colombina',
            pendingQuestion: 'Rebase?',
            pendingQuestionId: 'q-b'
          })
        ]
      })
    ])
    expect(result?.open.map((entry) => entry.questionId)).toEqual(['q-u', 'q-a', 'q-b'])
    expect(result?.open[0]).toEqual({
      questionId: 'q-u',
      question: 'Ship it?',
      agentId: USER_QUESTION_AGENT_ID
    })
    expect(result?.open[1]?.fromName).toBe('Caronte')
    expect(result?.orchestratorId).toBe('orch-1')
    expect(result?.memberIds).toEqual(['orch-1', 'worker-a', 'worker-b'])
  })

  it('drops questions the host could not address', () => {
    const result = cliQuestionContext('orch-1', [
      workspace({
        userQuestion: { questionId: '', question: 'Ghost?' },
        agents: [
          agent({ agentId: 'orch-1', name: 'Virgilio', roleId: 'orchestrator' }),
          agent({ pendingQuestion: 'Orphan?' }),
          agent({ agentId: 'worker-b', pendingQuestion: '   ', pendingQuestionId: 'q' })
        ]
      })
    ])
    expect(result?.open).toEqual([])
  })
})

describe('inboxForCliWindow', () => {
  const open = [
    { questionId: 'q-u', question: 'Ship it?', agentId: USER_QUESTION_AGENT_ID },
    { questionId: 'q-a', question: 'Use bcrypt?', agentId: 'worker-a', fromName: 'Caronte' }
  ]

  it('shows ask_user first on the orchestrator CLI, else the oldest child', () => {
    expect(
      inboxForCliWindow(ctx({ senderAgentId: 'orch-1', orchestratorId: 'orch-1', open }))
        ?.questionId
    ).toBe('q-u')
    expect(
      inboxForCliWindow(
        ctx({
          senderAgentId: 'orch-1',
          orchestratorId: 'orch-1',
          open: open.slice(1)
        })
      )?.questionId
    ).toBe('q-a')
  })

  it('shows a worker only its own question, even when ask_user is open', () => {
    expect(
      inboxForCliWindow(ctx({ senderAgentId: 'worker-a', orchestratorId: 'orch-1', open }))
        ?.questionId
    ).toBe('q-a')
    expect(
      inboxForCliWindow(ctx({ senderAgentId: 'worker-b', orchestratorId: 'orch-1', open }))
    ).toBeNull()
  })
})

describe('authorizeCliAnswer', () => {
  const open = [
    { questionId: 'q-u', question: 'Ship it?', agentId: USER_QUESTION_AGENT_ID },
    { questionId: 'q-a', question: 'Use bcrypt?', agentId: 'worker-a', fromName: 'Caronte' },
    { questionId: 'q-b', question: 'Rebase?', agentId: 'worker-b', fromName: 'Colombina' }
  ]
  const orch = ctx({ senderAgentId: 'orch-1', orchestratorId: 'orch-1', open })
  const worker = ctx({ senderAgentId: 'worker-a', orchestratorId: 'orch-1', open })

  it('lets the orchestrator answer ask_user and any child in the run', () => {
    expect(authorizeCliAnswer(orch, { agentId: USER_QUESTION_AGENT_ID, questionId: 'q-u' })).toBeNull()
    expect(authorizeCliAnswer(orch, { agentId: 'worker-b', questionId: 'q-b' })).toBeNull()
  })

  it('lets a worker answer only its own question', () => {
    expect(authorizeCliAnswer(worker, { agentId: 'worker-a', questionId: 'q-a' })).toBeNull()
    expect(authorizeCliAnswer(worker, { agentId: 'worker-b', questionId: 'q-b' })).toBe('not_allowed')
    expect(
      authorizeCliAnswer(worker, { agentId: USER_QUESTION_AGENT_ID, questionId: 'q-u' })
    ).toBe('not_allowed')
  })

  it('refuses an unknown question even for the orchestrator', () => {
    expect(authorizeCliAnswer(orch, { agentId: 'worker-a', questionId: 'ghost' })).toBe(
      'unknown_question'
    )
    expect(authorizeCliAnswer(orch, { agentId: 'ghost', questionId: 'q-a' })).toBe('unknown_question')
  })
})

describe('sameQuestionInbox', () => {
  it('treats two nulls as equal and differs on any field', () => {
    const a = { questionId: 'q', question: 'Hi?', agentId: 'worker-a', fromName: 'Caronte' }
    expect(sameQuestionInbox(null, null)).toBe(true)
    expect(sameQuestionInbox(a, { ...a })).toBe(true)
    expect(sameQuestionInbox(a, null)).toBe(false)
    expect(sameQuestionInbox(a, { ...a, question: 'Bye?' })).toBe(false)
  })
})
