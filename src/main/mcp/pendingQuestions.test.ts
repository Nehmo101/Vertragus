import { describe, expect, it } from 'vitest'
import { PendingQuestions, toOpenQuestionView } from './pendingQuestions'

function registry(): PendingQuestions {
  let n = 0
  return new PendingQuestions(
    () => `q${++n}`,
    () => 1000 + n
  )
}

describe('PendingQuestions', () => {
  it('hands out an id and tracks the open question per agent', () => {
    const questions = registry()
    const created = questions.create('a1', 'which interface?')
    expect(created.questionId).toBe('q1')
    expect(questions.openForAgent('a1')?.question).toBe('which interface?')
    expect(questions.openForAgent('a2')).toBeUndefined()
    expect(questions.openCount).toBe(1)
  })

  it('wakes every parked waiter of the same question with one answer', async () => {
    const questions = registry()
    const { questionId } = questions.create('a1', 'q?')
    const first = questions.waitForAnswer(questionId, 'a1', 5_000)
    const second = questions.waitForAnswer(questionId, 'a1', 5_000)

    expect(questions.answer(questionId, 'use zod')?.agentId).toBe('a1')

    await expect(first).resolves.toEqual({ state: 'answered', answer: 'use zod' })
    await expect(second).resolves.toEqual({ state: 'answered', answer: 'use zod' })
    expect(questions.openCount).toBe(0)
  })

  it('reports a timeout without closing the question', async () => {
    const questions = registry()
    const { questionId } = questions.create('a1', 'q?')
    await expect(questions.waitForAnswer(questionId, 'a1', 5)).resolves.toEqual({ state: 'timeout' })
    // Still open: the ticket resume must find the very same question.
    expect(questions.openForAgent('a1')?.questionId).toBe(questionId)
  })

  it('answers a late ticket resume from the answered memory', async () => {
    const questions = registry()
    const { questionId } = questions.create('a1', 'q?')
    await expect(questions.waitForAnswer(questionId, 'a1', 5)).resolves.toEqual({ state: 'timeout' })
    questions.answer(questionId, 'yes')
    // Resume arrives after the answer — it must not hang.
    await expect(questions.waitForAnswer(questionId, 'a1', 5_000)).resolves.toEqual({
      state: 'answered',
      answer: 'yes'
    })
  })

  it('treats an unknown ticket as unknown', async () => {
    const questions = registry()
    await expect(questions.waitForAnswer('nope', 'a1', 5_000)).resolves.toEqual({ state: 'unknown' })
    expect(questions.answer('nope', 'x')).toBeUndefined()
  })

  it('refuses a ticket that belongs to another agent', async () => {
    const questions = registry()
    const { questionId } = questions.create('a1', 'q?')
    await expect(questions.waitForAnswer(questionId, 'a2', 5_000)).resolves.toEqual({
      state: 'unknown'
    })
  })

  it('cancels the open questions of one agent only', async () => {
    const questions = registry()
    const mine = questions.create('a1', 'q1?')
    const theirs = questions.create('a2', 'q2?')
    const waiting = questions.waitForAnswer(mine.questionId, 'a1', 5_000)

    expect(questions.cancelForAgent('a1')).toBe(1)
    await expect(waiting).resolves.toEqual({ state: 'cancelled' })
    expect(questions.openForAgent('a2')?.questionId).toBe(theirs.questionId)
  })

  it('unparks on abort', async () => {
    const questions = registry()
    const { questionId } = questions.create('a1', 'q?')
    const controller = new AbortController()
    const waiting = questions.waitForAnswer(questionId, 'a1', 5_000, controller.signal)
    controller.abort()
    await expect(waiting).resolves.toEqual({ state: 'cancelled' })
  })

  it('clear() releases every waiter', async () => {
    const questions = registry()
    const a = questions.create('a1', 'q?')
    const b = questions.create('a2', 'q?')
    const waiting = [
      questions.waitForAnswer(a.questionId, 'a1', 5_000),
      questions.waitForAnswer(b.questionId, 'a2', 5_000)
    ]
    questions.clear()
    expect(await Promise.all(waiting)).toEqual([{ state: 'cancelled' }, { state: 'cancelled' }])
    expect(questions.openCount).toBe(0)
  })

  it('forgets answers beyond the memory bound instead of growing forever', async () => {
    const questions = new PendingQuestions()
    const first = questions.create('a1', 'q?')
    questions.answer(first.questionId, 'old')
    for (let i = 0; i < 60; i++) {
      const q = questions.create('a1', `q${i}?`)
      questions.answer(q.questionId, `a${i}`)
    }
    await expect(questions.waitForAnswer(first.questionId, 'a1', 5_000)).resolves.toEqual({
      state: 'unknown'
    })
  })

  it('preserves deliverAnswer on create/get/answer for sentinel PTY delivery', async () => {
    const questions = registry()
    const delivered: string[] = []
    const created = questions.create('a1', 'which file?', {
      deliverAnswer: async (answer) => {
        delivered.push(answer)
      }
    })
    expect(created.deliverAnswer).toBeTypeOf('function')
    expect(questions.get(created.questionId)?.deliverAnswer).toBeTypeOf('function')

    const closed = questions.answer(created.questionId, 'src/main/foo.ts')
    expect(closed?.deliverAnswer).toBeTypeOf('function')
    await closed!.deliverAnswer!('src/main/foo.ts')
    expect(delivered).toEqual(['src/main/foo.ts'])
    // MCP-created questions leave the callback unset.
    expect(questions.create('a2', 'plain?').deliverAnswer).toBeUndefined()
  })

  it('lists every open question for a succession package', () => {
    const questions = registry()
    questions.create('a1', 'one?')
    questions.create('a2', 'two?')
    expect(questions.listOpen().map((entry) => entry.question)).toEqual(['one?', 'two?'])
  })

  it('persists choices on create/get/list/answer and copies them so callers cannot mutate the registry', () => {
    const questions = registry()
    const labels = ['Postgres', 'SQLite']
    const created = questions.create('a1', 'which db?', { choices: labels })
    labels.push('MySQL')
    expect(created.choices).toEqual(['Postgres', 'SQLite'])
    expect(questions.get(created.questionId)?.choices).toEqual(['Postgres', 'SQLite'])
    expect(questions.openForAgent('a1')?.choices).toEqual(['Postgres', 'SQLite'])
    expect(questions.listOpen()[0]?.choices).toEqual(['Postgres', 'SQLite'])
    expect(questions.answer(created.questionId, 'Postgres')?.choices).toEqual(['Postgres', 'SQLite'])
    expect(questions.create('a2', 'plain?').choices).toBeUndefined()
  })

  it('omits an empty choices array rather than storing it', () => {
    const questions = registry()
    expect(questions.create('a1', 'q?', { choices: [] }).choices).toBeUndefined()
  })

  it('toOpenQuestionView copies choices and never leaks deliverAnswer', () => {
    const questions = registry()
    const created = questions.create('a1', 'which file?', {
      choices: ['src/a.ts', 'src/b.ts'],
      deliverAnswer: async () => undefined
    })
    expect(created.deliverAnswer).toBeTypeOf('function')
    expect(toOpenQuestionView(created)).toEqual({
      questionId: created.questionId,
      question: 'which file?',
      choices: ['src/a.ts', 'src/b.ts']
    })
    expect(toOpenQuestionView(questions.create('a2', 'plain?'))).toEqual({
      questionId: 'q2',
      question: 'plain?'
    })
  })
})
