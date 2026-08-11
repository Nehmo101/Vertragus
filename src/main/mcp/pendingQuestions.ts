/**
 * The open-question registry — the other half of the "no polling" story.
 *
 * A subagent's `ask_orchestrator` parks here; the orchestrator's
 * `send_to_agent{questionId}` resolves every parked caller at once. Answers of
 * already-closed questions are remembered for a while so the race that broke
 * the old repo cannot happen: the ask times out, the answer arrives one
 * millisecond later, and the agent's ticket resume would otherwise wait forever
 * for a question nobody will answer again.
 */
import { randomUUID } from 'node:crypto'

export interface PendingQuestion {
  questionId: string
  agentId: string
  question: string
  createdAt: number
}

export type AwaitAnswerResult =
  | { state: 'answered'; answer: string }
  | { state: 'timeout' }
  | { state: 'cancelled' }
  | { state: 'unknown' }

interface OpenEntry extends PendingQuestion {
  waiters: Set<{ resolve: (result: AwaitAnswerResult) => void; dispose: () => void }>
}

/** How many answered questions stay resolvable for a late ticket resume. */
const ANSWERED_MEMORY = 50

export class PendingQuestions {
  private readonly open = new Map<string, OpenEntry>()
  /** questionId -> answer, insertion-ordered, capped at {@link ANSWERED_MEMORY}. */
  private readonly answered = new Map<string, string>()

  constructor(
    private readonly newId: () => string = randomUUID,
    private readonly now: () => number = Date.now
  ) {}

  get openCount(): number {
    return this.open.size
  }

  /** Register a new question and return it (the caller pushes the event). */
  create(agentId: string, question: string): PendingQuestion {
    const entry: OpenEntry = {
      questionId: this.newId(),
      agentId,
      question,
      createdAt: this.now(),
      waiters: new Set()
    }
    this.open.set(entry.questionId, entry)
    return { ...entry }
  }

  get(questionId: string): PendingQuestion | undefined {
    const entry = this.open.get(questionId)
    return entry ? { ...entry } : undefined
  }

  /** The agent's currently unanswered question, if any (oldest first). */
  openForAgent(agentId: string): PendingQuestion | undefined {
    for (const entry of this.open.values()) {
      if (entry.agentId === agentId) return { ...entry }
    }
    return undefined
  }

  /**
   * Block until the question is answered, the timeout elapses, the question is
   * cancelled, or immediately when it was already answered / is unknown.
   */
  waitForAnswer(
    questionId: string,
    agentId: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<AwaitAnswerResult> {
    const remembered = this.answered.get(questionId)
    if (remembered !== undefined) return Promise.resolve({ state: 'answered', answer: remembered })

    const entry = this.open.get(questionId)
    // A ticket from another agent is not a valid resume — treat it as unknown
    // rather than letting one agent siphon off another agent's answer.
    if (!entry || entry.agentId !== agentId) return Promise.resolve({ state: 'unknown' })
    if (timeoutMs <= 0 || signal?.aborted) return Promise.resolve({ state: 'timeout' })

    return new Promise<AwaitAnswerResult>((resolve) => {
      const timer = setTimeout(() => {
        entry.waiters.delete(waiter)
        waiter.dispose()
        resolve({ state: 'timeout' })
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      const onAbort = (): void => {
        entry.waiters.delete(waiter)
        waiter.dispose()
        resolve({ state: 'cancelled' })
      }

      const waiter = {
        resolve,
        dispose: (): void => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        }
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      entry.waiters.add(waiter)
    })
  }

  /** Answer a question: wake every parked caller. Returns false if unknown. */
  answer(questionId: string, answer: string): PendingQuestion | undefined {
    const entry = this.open.get(questionId)
    if (!entry) return undefined
    this.open.delete(questionId)
    this.remember(questionId, answer)
    for (const waiter of [...entry.waiters]) {
      entry.waiters.delete(waiter)
      waiter.dispose()
      waiter.resolve({ state: 'answered', answer })
    }
    return {
      questionId: entry.questionId,
      agentId: entry.agentId,
      question: entry.question,
      createdAt: entry.createdAt
    }
  }

  /** Drop every open question of an agent (it is being stopped or died). */
  cancelForAgent(agentId: string): number {
    let cancelled = 0
    for (const entry of [...this.open.values()]) {
      if (entry.agentId !== agentId) continue
      this.open.delete(entry.questionId)
      cancelled++
      for (const waiter of [...entry.waiters]) {
        entry.waiters.delete(waiter)
        waiter.dispose()
        waiter.resolve({ state: 'cancelled' })
      }
    }
    return cancelled
  }

  /** Release everything (workspace shutdown). */
  clear(): void {
    for (const agentId of new Set([...this.open.values()].map((entry) => entry.agentId))) {
      this.cancelForAgent(agentId)
    }
    this.answered.clear()
  }

  private remember(questionId: string, answer: string): void {
    this.answered.set(questionId, answer)
    while (this.answered.size > ANSWERED_MEMORY) {
      const oldest = this.answered.keys().next()
      if (oldest.done) break
      this.answered.delete(oldest.value)
    }
  }
}
