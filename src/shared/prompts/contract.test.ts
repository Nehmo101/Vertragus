import { describe, expect, it } from 'vitest'
import { buildReminderSuffix, buildTaskContract, CONTRACT_MARKER } from './contract'

/** MCP contract text pinned so 'mcp' stays byte-identical across refactors. */
const MCP_CONTRACT_SNAPSHOT = [
  '--- Contract (Vertragus) ---',
  'You are the "worker" agent of this Vertragus workspace.',
  'You report to an orchestrator agent through MCP tools. Follow these rules for every task:',
  '1. Do the work yourself. Read the repository, change the files, run the checks.',
  '2. When the task is finished, call report_done with a short factual summary of what you changed and how you verified it. Use status "success" only when you verified it, "blocked" when something outside your control stops you, "failed" when you tried and it does not work.',
  '3. If you need a decision, a permission, an interface, or information you cannot obtain yourself, call ask_orchestrator and wait for the answer. Do not guess, do not pick a random option, and do not idle.',
  '4. If ask_orchestrator returns answer: null and a ticket, call it again with that same ticket. Do not rephrase the question and do not open a second question.',
  '5. Send a one-line report_progress on real milestones only, not as a heartbeat.',
  '6. Never stop working silently and never end your turn without either report_done or an open ask_orchestrator.',
  '7. After report_done, stay available: the orchestrator either sends you a follow-up task or stops you.',
  '--- End of contract ---'
].join('\n')

describe('buildTaskContract', () => {
  it('names the agent when the name is already known', () => {
    expect(buildTaskContract({ agentName: 'Colombina', role: 'worker' })).toContain(
      'You are Colombina, the "worker" agent'
    )
  })

  it('falls back to the role when the name is not allocated yet', () => {
    const contract = buildTaskContract({ role: 'reviewer' })
    expect(contract).toContain('You are the "reviewer" agent')
    expect(contract).not.toContain('undefined')
  })

  it('names the three subagent tools and forbids guessing and idling', () => {
    const contract = buildTaskContract({ role: 'worker' })
    expect(contract).toContain('report_done')
    expect(contract).toContain('ask_orchestrator')
    expect(contract).toContain('report_progress')
    expect(contract).toMatch(/do not guess/i)
    expect(contract).toMatch(/do not idle/i)
  })

  it('teaches the ticket resume rule so a timeout cannot spawn a second question', () => {
    const contract = buildTaskContract({ role: 'worker' })
    expect(contract).toContain('answer: null')
    expect(contract).toMatch(/same ticket/i)
    expect(contract).toMatch(/do not rephrase/i)
  })

  it('spells out the three done statuses', () => {
    const contract = buildTaskContract({ role: 'worker' })
    for (const status of ['success', 'blocked', 'failed']) expect(contract).toContain(status)
  })

  it('is fenced by a recognisable marker at both ends', () => {
    const contract = buildTaskContract({ role: 'worker' })
    expect(contract.startsWith(CONTRACT_MARKER)).toBe(true)
    expect(contract.trimEnd().endsWith('---')).toBe(true)
  })

  it('keeps the mcp dialect byte-identical to the historical wording', () => {
    expect(buildTaskContract({ role: 'worker' })).toBe(MCP_CONTRACT_SNAPSHOT)
    expect(buildTaskContract({ role: 'worker', reporting: 'mcp' })).toBe(MCP_CONTRACT_SNAPSHOT)
  })
})

describe('buildTaskContract — sentinel dialect', () => {
  it('teaches split marker halves and the three report kinds', () => {
    const contract = buildTaskContract({ role: 'worker', reporting: 'sentinel' })
    expect(contract).toContain('@@VERT')
    expect(contract).toContain('RAGUS:DONE@@')
    expect(contract).toContain('RAGUS:ASK@@')
    expect(contract).toContain('RAGUS:PROGRESS@@')
    expect(contract).toMatch(/immediately followed by/)
    expect(contract).toContain('summary')
    expect(contract).toContain('question')
    expect(contract).toContain('note')
    for (const status of ['success', 'blocked', 'failed']) expect(contract).toContain(status)
  })

  it('is echo-safe: whitespace-stripped text never contains a joined start marker', () => {
    const contract = buildTaskContract({ role: 'worker', reporting: 'sentinel' })
    const stripped = contract.replace(/\s+/g, '')
    // TUI rewrap only inserts breaks; stripping them must still not join halves.
    expect(stripped).not.toMatch(/@@VERTRAGUS:/)
    expect(contract).not.toMatch(/@@VERTRAGUS:/)
  })

  it('keeps end-marker halves separated by a non-whitespace word too', () => {
    const contract = buildTaskContract({ role: 'worker', reporting: 'sentinel' })
    const stripped = contract.replace(/\s+/g, '')
    // Literal @@END@@ must not appear adjacent to a start half in the teaching text.
    expect(stripped).not.toMatch(/@@VERT(?:RAGUS:(?:DONE|ASK|PROGRESS)@@)[^@]*@@END@@/)
  })
})

describe('buildTaskContract — D4 approvals', () => {
  it('inserts the approval rule after the ask rule and renumbers cleanly (mcp)', () => {
    const contract = buildTaskContract({ role: 'worker', approvals: 'ask-orchestrator' })
    expect(contract).toContain(
      '4. Before an action that is hard to undo or that reaches beyond your worktree'
    )
    expect(contract).toContain('wait for the approval')
    expect(contract).toContain('needs no approval')
    // The old rules 4–7 shift down by one; the last rule keeps its content.
    expect(contract).toContain('5. If ask_orchestrator returns answer: null and a ticket')
    expect(contract).toContain('8. After report_done, stay available')
  })

  it('inserts the approval rule in the sentinel dialect and stays echo-safe', () => {
    const contract = buildTaskContract({
      role: 'worker',
      reporting: 'sentinel',
      approvals: 'ask-orchestrator'
    })
    expect(contract).toContain('4. Before an action that is hard to undo')
    expect(contract).toContain('print one ASK report line as taught above')
    expect(contract).toContain('8. After a DONE report line, stay available')
    expect(contract.replace(/\s+/g, '')).not.toMatch(/@@VERTRAGUS:/)
  })

  it('leaves both dialects untouched when approvals is unset', () => {
    expect(buildTaskContract({ role: 'worker' })).not.toContain('approval')
    expect(buildTaskContract({ role: 'worker', reporting: 'sentinel' })).not.toContain('approval')
  })
})

describe('buildReminderSuffix', () => {
  it('stays short and repeats only the two obligations', () => {
    const reminder = buildReminderSuffix()
    expect(reminder.split('\n')).toHaveLength(2)
    expect(reminder).toContain('report_done')
    expect(reminder).toContain('ask_orchestrator')
    expect(reminder.length).toBeLessThan(220)
  })

  it('sentinel reminder also stays short and echo-safe', () => {
    const reminder = buildReminderSuffix('sentinel')
    expect(reminder.split('\n')).toHaveLength(2)
    expect(reminder).toContain('DONE')
    expect(reminder).toContain('ASK')
    expect(reminder.replace(/\s+/g, '')).not.toMatch(/@@VERTRAGUS:/)
    expect(reminder.length).toBeLessThan(220)
  })
})
