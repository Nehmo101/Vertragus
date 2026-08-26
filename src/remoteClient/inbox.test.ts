import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RemoteAgentSummary, RemoteWorkspaceSummary } from '@shared/remote/protocol'
import {
  inboxEntriesFor,
  inboxPrompt,
  inboxSource,
  questionInbox,
  USER_AGENT_ID
} from './inbox'

/**
 * The reserved addressee is one value in three places: the host's registry
 * (`USER_QUESTION_AGENT_ID`), the desktop panel's answer call, and this
 * bundle's own copy — which cannot import the first, because the web
 * tsconfig does not see `src/main` and a browser bundle has no business
 * pulling main-process code in to reach a string. So the invariant is pinned
 * the way this project pins its other cross-cutting rules: by reading the
 * file, with a self-check that fails loudly if the scan itself breaks.
 */
describe('the reserved addressee', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const read = (relative: string): string => readFileSync(join(root, relative), 'utf8')

  it('is the same string the host answers questions under', () => {
    const declaration = /export const USER_QUESTION_AGENT_ID = '([^']+)'/.exec(
      read('main/mcp/types.ts')
    )
    expect(declaration, 'USER_QUESTION_AGENT_ID not found in src/main/mcp/types.ts').not.toBeNull()
    expect(USER_AGENT_ID).toBe(declaration?.[1])
  })

  it('is the same string the desktop panel sends', () => {
    const call = /onAnswer\(workspaceId, '([^']+)', questionId/.exec(
      read('renderer/src/panel/WorkspaceCard.tsx')
    )
    expect(call, 'the panel answer call not found — has it been reshaped?').not.toBeNull()
    expect(USER_AGENT_ID).toBe(call?.[1])
  })
})

function agent(overrides: Partial<RemoteAgentSummary> = {}): RemoteAgentSummary {
  return {
    agentId: 'a1',
    name: 'Caronte',
    roleId: 'worker',
    roleColor: '#2f7d6d',
    state: 'waiting',
    ...overrides
  }
}

function workspace(overrides: Partial<RemoteWorkspaceSummary> = {}): RemoteWorkspaceSummary {
  return {
    workspaceId: 'w1',
    name: 'Paradiso',
    profileId: 'p1',
    active: true,
    agents: [],
    ...overrides
  }
}

describe('questionInbox', () => {
  it('collects ask_user and agent questions, ask_user first', () => {
    const entries = questionInbox([
      workspace({
        workspaceId: 'w1',
        agents: [
          agent({
            pendingQuestion: 'Use bcrypt?',
            pendingQuestionId: 'q-a',
            pendingQuestionChoices: ['Yes', 'No']
          })
        ]
      }),
      workspace({
        workspaceId: 'w2',
        name: 'Inferno',
        userQuestion: { questionId: 'q-u', question: 'Ship it?', choices: ['Ship', 'Wait'] },
        agents: [
          agent({ agentId: 'a2', name: 'Virgilio', pendingQuestion: 'Rebase?', pendingQuestionId: 'q-b' })
        ]
      })
    ])
    expect(entries.map((entry) => entry.questionId)).toEqual(['q-u', 'q-a', 'q-b'])
    expect(entries[0]).toMatchObject({
      kind: 'user',
      agentId: USER_AGENT_ID,
      workspaceName: 'Inferno',
      question: 'Ship it?',
      choices: ['Ship', 'Wait']
    })
    expect(entries[0]?.agentName).toBeUndefined()
    expect(entries[1]).toMatchObject({
      kind: 'agent',
      agentId: 'a1',
      agentName: 'Caronte',
      choices: ['Yes', 'No']
    })
  })

  it('drops questions that answer_question could not address', () => {
    expect(
      questionInbox([
        workspace({ agents: [agent({ pendingQuestion: 'Orphan?' })] }),
        workspace({ workspaceId: 'w2', agents: [agent({ pendingQuestion: '   ', pendingQuestionId: 'q' })] }),
        workspace({ workspaceId: 'w3', userQuestion: { questionId: '', question: 'Ghost?' } })
      ])
    ).toEqual([])
  })

  it('trims the question text it hands to the answer field', () => {
    const [entry] = questionInbox([
      workspace({ userQuestion: { questionId: 'q', question: '  Ship it?\n' } })
    ])
    expect(entry?.question).toBe('Ship it?')
  })

  it('keys an entry by workspace, addressee and question', () => {
    const shared = { questionId: 'q-1', question: 'Same id, other run?' }
    const entries = questionInbox([
      workspace({ workspaceId: 'w1', userQuestion: shared }),
      workspace({ workspaceId: 'w2', userQuestion: shared })
    ])
    expect(entries.map((entry) => entry.key)).toEqual(['w1:user:q-1', 'w2:user:q-1'])
  })
})

describe('inbox rendering helpers', () => {
  const copy = { userQuestion: (question: string) => `Frage an dich: ${question}` }

  it('frames an ask_user as addressed to the human and leaves agent text alone', () => {
    expect(inboxPrompt({ kind: 'user', question: 'Ship it?' }, copy)).toBe('Frage an dich: Ship it?')
    expect(inboxPrompt({ kind: 'agent', question: 'Use bcrypt?' }, copy)).toBe('Use bcrypt?')
  })

  it('strips a parsed numbered list from the prompt the human reads', () => {
    expect(
      inboxPrompt({ kind: 'agent', question: 'Which db?\n1. Postgres\n2. SQLite' }, copy)
    ).toBe('Which db?')
    expect(
      inboxPrompt({ kind: 'user', question: 'Ship?\n1. Yes\n2. No' }, copy)
    ).toBe('Frage an dich: Ship?')
  })

  it('names the workspace, and the agent when there is one', () => {
    expect(inboxSource({ workspaceName: 'Paradiso', agentName: 'Caronte' })).toBe(
      'Paradiso · Caronte'
    )
    expect(inboxSource({ workspaceName: 'Paradiso' })).toBe('Paradiso')
  })

  it('splits the inbox back onto its cards without losing an entry', () => {
    const entries = questionInbox([
      workspace({ workspaceId: 'w1', userQuestion: { questionId: 'q-u', question: 'Ship it?' } }),
      workspace({
        workspaceId: 'w2',
        agents: [agent({ pendingQuestion: 'Rebase?', pendingQuestionId: 'q-a' })]
      })
    ])
    expect(inboxEntriesFor(entries, 'w1').map((entry) => entry.questionId)).toEqual(['q-u'])
    expect(inboxEntriesFor(entries, 'w2').map((entry) => entry.questionId)).toEqual(['q-a'])
    expect(inboxEntriesFor(entries, 'w3')).toEqual([])
  })
})
