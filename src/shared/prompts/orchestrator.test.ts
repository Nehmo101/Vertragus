import { describe, expect, it } from 'vitest'
import { buildLeadSystemPrompt, buildOrchestratorSystemPrompt } from './orchestrator'

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
    expect(prompt).toContain('start_agent{role, task, model?, providerId?, slotId?, baseBranch?}')
  })

  it('teaches baseBranch as the way to chain one agent’s work onto another’s', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toMatch(/baseBranch set to the first agent’s branch/i)
    expect(prompt).toMatch(/reports every agent’s branch back/i)
  })

  it('names all orchestrator tools', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    for (const tool of [
      'start_agent',
      'send_to_agent',
      'await_events',
      'list_agents',
      'inspect_agent',
      'read_output',
      'stop_agent',
      'record_retro',
      'request_succession'
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

  it('orders verification cheapest-first: status before a full diff', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toMatch(/view "status" \(porcelain \+ diffstat\) first/i)
    expect(prompt).toMatch(/full diff only when something looks off/i)
    expect(prompt).toMatch(/pass path to scope the diff/i)
  })

  it('teaches model economy for role and slot choice', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toMatch(/smaller, faster slot or model/i)
    expect(prompt).toMatch(/reserve the strongest ones for review, architecture/i)
  })

  it('forbids coding and requires a closing summary plus stop', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toMatch(/never edit, create or delete files yourself/i)
    expect(prompt).toMatch(/stop every remaining agent with stop_agent/i)
    expect(prompt).toMatch(/one summary/i)
  })

  it('teaches request_succession as serial replacement, not run end', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toMatch(/request_succession\{reason/)
    expect(prompt).toMatch(/fresh context/i)
    expect(prompt).toMatch(/not a second concurrent orchestrator/i)
    expect(prompt).toMatch(/never as part of a context handoff/i)
  })

  it('asks for succession early instead of at the context wall', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toMatch(/Call it EARLY and proactively/)
    expect(prompt).toMatch(/do not wait for a provider context warning/i)
  })

  it('forbids native spawn_subagent, write, and shell', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toMatch(/do not use native spawn_subagent, write, or shell/i)
    expect(prompt).toMatch(/vertragus start_agent/i)
  })

  it('teaches live steering of running agents and one helper level under workers', () => {
    const prompt = buildOrchestratorSystemPrompt(base)
    expect(prompt).toMatch(/Handle it immediately/)
    expect(prompt).toMatch(/relayViaAgentId/)
    expect(prompt).toMatch(/Never type the user’s words into your own prompt/)
    expect(prompt).toMatch(/Workers you start over MCP may start helpers/)
    expect(prompt).toMatch(/Lead-starts-lead remains forbidden/)
  })

  it('I1: thorough intake closes AC and DoD before the team starts, or skips ask_user when complete', () => {
    const prompt = buildOrchestratorSystemPrompt({ ...base, questionMode: 'thorough' })
    expect(prompt).toMatch(/0\. Close the brief/)
    expect(prompt).toMatch(/four-line brief/)
    expect(prompt).toMatch(/If there are no holes, do not call ask_user/)
    expect(prompt).toMatch(/Never guess a product or scope decision/)
    expect(prompt).toMatch(/start_agent\{role:scout\}/)
    expect(prompt).toMatch(/If scout is not in Available roles/)
    expect(prompt).toMatch(/Never start a worker to "just look around"/)
    expect(prompt).toMatch(/Do not write HOW/)
    expect(prompt).toMatch(/acceptance criteria/)
    expect(prompt).toMatch(/Definition of Done/)
  })

  it('is plain English with no German left in it', () => {
    for (const questionMode of [undefined, 'none', 'few', 'thorough'] as const) {
      const prompt = buildOrchestratorSystemPrompt(
        questionMode === undefined ? base : { ...base, questionMode }
      )
      expect(prompt).not.toMatch(/\b(der|die|das|und|nicht|Agenten)\b/)
    }
  })

  it('always briefs questionMode, defaulting omitted input to few', () => {
    const omitted = buildOrchestratorSystemPrompt(base)
    const few = buildOrchestratorSystemPrompt({ ...base, questionMode: 'few' })
    const none = buildOrchestratorSystemPrompt({ ...base, questionMode: 'none' })
    const thorough = buildOrchestratorSystemPrompt({ ...base, questionMode: 'thorough' })

    expect(omitted).toBe(few)
    expect(omitted).toContain('Question mode for this run')
    expect(omitted).toContain('No intake round of clarifying questions')

    expect(few).toContain('only genuine user decisions')
    expect(few).toContain('a product choice the goal does not settle')
    expect(few).not.toContain('the goal text is authoritative')
    expect(few).not.toContain('close the brief')

    expect(none).toContain('the goal text is authoritative')
    expect(none).toContain('Do not fish for extra requirements')
    expect(none).toContain('Do not run intake')
    expect(none).toContain('STILL call ask_user for a destructive action')
    expect(none).not.toContain('a product choice the goal does not settle')
    expect(none).not.toContain('No intake round of clarifying questions')
    expect(none).not.toMatch(/ask_user[^.]*product choice/i)
    expect(none).toContain('answer it yourself')
    expect(none).toContain('Escalate with ask_user only for a destructive action')

    expect(thorough).toContain('before starting the team, close the brief')
    expect(thorough).toContain('one numbered ask_user, batched')
    expect(thorough).toContain('0. Close the brief:')
    expect(thorough).toContain('Never guess a product or scope decision the goal does not settle')
    expect(omitted).not.toContain('0. Close the brief:')
    expect(none).not.toContain('0. Close the brief:')
    expect(few).not.toContain('0. Close the brief:')
  })

  it('does not brief the lead with questionMode', () => {
    const prompt = buildLeadSystemPrompt({ ...base, area: 'payments' })
    expect(prompt).not.toContain('Question mode for this run')
    expect(prompt).not.toContain('ask_user')
  })
})
