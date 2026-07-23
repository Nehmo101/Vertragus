import { describe, expect, it } from 'vitest'
import type { VertragusTask } from '@shared/orchestrator'
import { applyTaskTransition, isAllowedTaskTransition } from './taskStateMachine'

function task(status: VertragusTask['status']): VertragusTask {
  return { id: 't1', title: 'T', role: 'codex', status, createdAt: 1 }
}

describe('task state machine', () => {
  it('keeps stopped absorbing except for the explicit revival to queued', () => {
    expect(isAllowedTaskTransition('stopped', 'queued')).toBe(true)
    for (const to of ['running', 'waiting', 'paused', 'success', 'needs-work', 'error'] as const) {
      expect(isAllowedTaskTransition('stopped', to)).toBe(false)
    }
  })

  it('allows the regular lifecycle and retry paths', () => {
    expect(isAllowedTaskTransition('queued', 'running')).toBe(true)
    expect(isAllowedTaskTransition('running', 'success')).toBe(true)
    expect(isAllowedTaskTransition('running', 'paused')).toBe(true)
    expect(isAllowedTaskTransition('paused', 'queued')).toBe(true)
    expect(isAllowedTaskTransition('error', 'queued')).toBe(true)
    expect(isAllowedTaskTransition('needs-work', 'queued')).toBe(true)
    // Gate arbitration may re-grade a worker verdict after the fact.
    expect(isAllowedTaskTransition('success', 'needs-work')).toBe(true)
  })

  it('treats same-status writes as idempotent refreshes', () => {
    expect(isAllowedTaskTransition('running', 'running')).toBe(true)
  })

  it('applies status and patch atomically — or not at all', () => {
    const cancelled = task('stopped')
    const refused = applyTaskTransition(cancelled, 'running', { lastAction: 'Worker startet' })
    expect(refused).toEqual({ ok: false, from: 'stopped' })
    expect(cancelled.status).toBe('stopped')
    expect(cancelled.lastAction).toBeUndefined()

    const queued = task('queued')
    const applied = applyTaskTransition(queued, 'running', { lastAction: 'Worker startet' })
    expect(applied).toEqual({ ok: true, from: 'queued' })
    expect(queued.status).toBe('running')
    expect(queued.lastAction).toBe('Worker startet')
  })
})
