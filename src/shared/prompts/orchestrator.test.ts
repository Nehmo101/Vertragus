import { describe, expect, it } from 'vitest'
import { buildOrchestratorSystemPrompt } from './orchestrator'

const base = {
  workspaceName: 'Arsenale 2',
  repoPath: 'C:\\git\\demo',
  rolesWithLimits: [
    { id: 'worker', description: 'implements changes', max: 3 },
    { id: 'reviewer' }
  ]
}

describe('buildOrchestratorSystemPrompt', () => {
  it('states workspace and repository', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toContain('Arsenale 2')
    expect(prompt).toContain('C:\\git\\demo')
  })

  it('lists every role with its limit', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toContain('- worker (max 3 at a time) — implements changes')
    expect(prompt).toContain('- reviewer (no limit)')
  })

  it('mentions the global cap only when there is one', () => {
    expect(buildOrchestratorSystemPrompt({ ...base, maxSubagents: 4 })).toContain('at most 4 agents')
    expect(buildOrchestratorSystemPrompt(base)).toContain('no global cap')
  })

  it('warns when no role is configured instead of silently listing nothing', () => {
    const prompt = buildOrchestratorSystemPrompt({ ...base, rolesWithLimits: [] })
    expect(prompt).toMatch(/no roles configured/i)
  })

  it('explains that every agent works in its own worktree and merging is delegated', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toMatch(/each work in a separate git worktree/i)
    expect(prompt).toMatch(/merging the other branches into its own/i)
    // The old opt-in flag is gone — the prompt must not teach it.
    expect(prompt).not.toContain('worktree: true')
    expect(prompt).toContain('start_agent{role, task, model?, baseBranch?}')
  })

  it('teaches baseBranch as the way to chain one agent’s work onto another’s', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toMatch(/baseBranch set to the first agent’s branch/i)
    expect(prompt).toMatch(/reports every agent’s branch back/i)
  })

  it('names all eight orchestrator tools', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    for (const tool of [
      'start_agent',
      'send_to_agent',
      'await_events',
      'list_agents',
      'inspect_agent',
      'read_output',
      'stop_agent',
      'record_retro'
    ]) {
      expect(prompt).toContain(tool)
    }
  })

  it('demands one closing record_retro with the never-invent-a-weakness rule', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toMatch(/call record_retro exactly once/i)
    expect(prompt).toMatch(/never invent a weakness/i)
    expect(prompt).toMatch(/leave a slot empty otherwise/i)
  })

  it('renders the track record only when knowledge exists', () => {
    expect(buildOrchestratorSystemPrompt(base)).not.toContain('Track record')

    const prompt = buildOrchestratorSystemPrompt({
      ...base,
      knowledge: [
        {
          roleId: 'worker',
          providerId: 'codex',
          model: 'gpt-x',
          score: { samples: 8, successRate: 0.75, score: 0.62 },
          strengths: ['fast on UI tasks'],
          weaknesses: ['weak on migrations']
        },
        {
          roleId: 'reviewer',
          providerId: 'claude',
          model: '',
          strengths: [],
          weaknesses: ['times out on long diffs']
        }
      ]
    })
    expect(prompt).toContain('Track record from previous runs on this machine')
    expect(prompt).toContain(
      '- worker (codex/gpt-x): score 62 (8 tasks, 75% success). Strengths: fast on UI tasks. Weaknesses: weak on migrations.'
    )
    expect(prompt).toContain(
      '- reviewer (claude/default model): no score yet. Weaknesses: times out on long diffs.'
    )
  })

  it('makes the await_events loop mandatory and forbids polling', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toMatch(/never sit idle without an open await_events call/i)
    expect(prompt).toMatch(/never poll list_agents/i)
  })

  it('requires prompt answers to agent_question', () => {
    expect(buildOrchestratorSystemPrompt(base)).toMatch(
      /agent_question: answer it promptly with send_to_agent/i
    )
  })

  it('requires read_output verification for unconfirmed exits', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toContain('confirmed: false')
    expect(prompt).toMatch(/call read_output on it first/i)
  })

  it('teaches inspect_agent as the way to verify file changes', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toMatch(/inspect_agent\{agentId, view, path\?, lines\?\}/)
    expect(prompt).toMatch(/never treat the terminal tail as a diff/i)
    expect(prompt).toMatch(/verify the result with inspect_agent/i)
    expect(prompt).toMatch(/host facts on the event/i)
  })

  it('forbids coding and requires a closing summary plus stop', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toMatch(/never edit, create or delete files yourself/i)
    expect(prompt).toMatch(/stop every remaining agent with stop_agent/i)
    expect(prompt).toMatch(/one summary/i)
  })

  it('is plain English with no German left in it', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).not.toMatch(/\b(der|die|das|und|nicht|Agenten)\b/)
  })
})
