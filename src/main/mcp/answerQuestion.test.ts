import { describe, expect, it, vi } from 'vitest'
import { answerAgentQuestion } from './answerQuestion'
import { PendingQuestions } from './pendingQuestions'

describe('answerAgentQuestion — the one host path behind tool, panel, gateway and CLI overlay (H1)', () => {
  it('wakes a parked ask_orchestrator waiter — the gateway path resolves the same registry', async () => {
    const questions = new PendingQuestions()
    const pending = questions.create('agent-1', 'Which hash algorithm?')
    // The subagent's ask_orchestrator parks exactly like this.
    const waiter = questions.waitForAnswer(pending.questionId, 'agent-1', 5_000)

    const outcome = await answerAgentQuestion(
      questions,
      'agent-1',
      pending.questionId,
      'Use bcrypt.'
    )

    expect(outcome).toEqual({ ok: true, agentId: 'agent-1', questionId: pending.questionId })
    await expect(waiter).resolves.toEqual({ state: 'answered', answer: 'Use bcrypt.' })
    expect(questions.openForAgent('agent-1')).toBeUndefined()
  })

  it('refuses an unknown question without touching the registry', async () => {
    const questions = new PendingQuestions()
    const outcome = await answerAgentQuestion(questions, 'agent-1', 'ghost', 'answer')
    expect(outcome).toEqual({ ok: false, error: 'unknown_question', questionId: 'ghost' })
  })

  it('refuses an answer addressed to the wrong agent and names the owner', async () => {
    const questions = new PendingQuestions()
    const pending = questions.create('agent-1', 'Q?')
    const outcome = await answerAgentQuestion(questions, 'agent-2', pending.questionId, 'answer')
    expect(outcome).toEqual({
      ok: false,
      error: 'question_agent_mismatch',
      questionId: pending.questionId,
      expectedAgentId: 'agent-1'
    })
    // Still open — nothing was consumed.
    expect(questions.openForAgent('agent-1')?.questionId).toBe(pending.questionId)
  })

  it('delivers sentinel answers to the PTY FIRST and keeps the question open when that fails', async () => {
    const questions = new PendingQuestions()
    const deliverAnswer = vi
      .fn<(answer: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('seed failed'))
      .mockResolvedValueOnce(undefined)
    const pending = questions.create('agent-1', 'Sentinel?', { deliverAnswer })

    const failed = await answerAgentQuestion(questions, 'agent-1', pending.questionId, 'first try')
    expect(failed).toEqual({
      ok: false,
      error: 'answer_delivery_failed',
      questionId: pending.questionId,
      message: 'seed failed'
    })
    // The question survives a failed delivery so the caller can retry.
    expect(questions.openForAgent('agent-1')?.questionId).toBe(pending.questionId)

    const retried = await answerAgentQuestion(questions, 'agent-1', pending.questionId, 'second try')
    expect(retried).toEqual({ ok: true, agentId: 'agent-1', questionId: pending.questionId })
    expect(deliverAnswer).toHaveBeenLastCalledWith('second try')
    expect(questions.openForAgent('agent-1')).toBeUndefined()
  })
})
