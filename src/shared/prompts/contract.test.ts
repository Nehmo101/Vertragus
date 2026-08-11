import { describe, expect, it } from 'vitest'
import { buildReminderSuffix, buildTaskContract, CONTRACT_MARKER } from './contract'

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
})

describe('buildReminderSuffix', () => {
  it('stays short and repeats only the two obligations', () => {
    const reminder = buildReminderSuffix()
    expect(reminder.split('\n')).toHaveLength(2)
    expect(reminder).toContain('report_done')
    expect(reminder).toContain('ask_orchestrator')
    expect(reminder.length).toBeLessThan(220)
  })
})
