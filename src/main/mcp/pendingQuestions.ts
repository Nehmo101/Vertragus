/**
 * The open-question registry — the other half of the "no polling" story.
 *
 * A subagent's `ask_orchestrator` parks here; the orchestrator's
 * `send_to_agent{questionId}` resolves every parked caller at once. Answers of
 * already-closed questions are remembered for a while so the race that broke
 * the old repo cannot happen: the ask times out, the answer arrives one
 * millisecond later, and the agent's ticket resume would otherwise wait forever
 * for a question nobody will answer again.
 *
 * Sentinel (PTY-only) questions optionally carry a {@link PendingQuestion.deliverAnswer}
 * callback: answering still closes the registry entry synchronously, then the
 * MCP layer awaits the callback to type the answer into the agent's PTY.
 * MCP-tool questions leave the callback unset — their delivery is the resolving
 * `waitForAnswer` response.
 */
import { randomUUID } from 'node:crypto'

export interface PendingQuestion {
  questionId: string
  agentId: string
  question: string
  createdAt: number
  /**
   * Optional short labels for a decision. The human taps one to submit that
   * label as the answer; the custom text field stays available either way.
   * Sentinel PTY questions leave this unset — buttons then come only from
   * parsing the question text.
   */
  choices?: string[]
  /**
   * Optional PTY delivery for sentinel questions. Invoked by
   * `send_to_agent{questionId}` after {@link PendingQuestions.answer} returns.
   * Never copied onto the panel / remote view ({@link toOpenQuestionView}).
   */
  deliverAnswer?: (answer: string) => Promise<void>
}

export interface CreateQuestionOptions {
  deliverAnswer?: (answer: string) => Promise<void>
  choices?: string[]
}

/**
 * Renderer-safe open question — id, prompt, optional choices. Never includes
 * {@link PendingQuestion.deliverAnswer}.
 */
export interface OpenQuestionView {
  questionId: string
  question: string
  choices?: string[]
}

export function toOpenQuestionView(question: PendingQuestion): OpenQuestionView {
  return {
    questionId: question.questionId,
    question: question.question,
    ...(question.choices && question.choices.length > 0 ? { choices: question.choices } : {})
  }
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

function copiedChoices(choices: readonly string[] | undefined): string[] | undefined {
  if (!choices || choices.length === 0) return undefined
  return [...choices]
}

function publicQuestion(entry: OpenEntry): PendingQuestion {
  return {
    questionId: entry.questionId,
    agentId: entry.agentId,
    question: entry.question,
    createdAt: entry.createdAt,
    ...(entry.choices && entry.choices.length > 0 ? { choices: entry.choices } : {}),
    ...(entry.deliverAnswer ? { deliverAnswer: entry.deliverAnswer } : {})
  }
}

export class PendingQuestions {
  private readonly open = new Map<string, OpenEntry>()
  /** questionId -> answer, insertion-ordered, capped at {@link ANSWERED_MEMORY}. */
  private readonly answered = new Map<string, string>()
  private readonly mutationListeners = new Set<() => void>()

  constructor(
    private readonly newId: () => string = randomUUID,
    private readonly now: () => number = Date.now
  ) {}

  get openCount(): number {
    return this.open.size
  }

  /**
   * Fires after every change to the set of open questions (create, answer,
   * cancel, clear). The panel's question badges derive from this registry, and
   * only `create` has a companion event — an answered badge would otherwise
   * stay lit until something else happens to refresh the view. Native
   * taskbar/dock attention follows {@link openCount} on the same feed
   * (`src/main/windows/panelAttention.ts`).
   */
  onMutate(listener: () => void): () => void {
    this.mutationListeners.add(listener)
    return () => {
      this.mutationListeners.delete(listener)
    }
  }

  private notifyMutation(): void {
    for (const listener of [...this.mutationListeners]) listener()
  }

  /** Register a new question and return it (the caller pushes the event). */
  create(agentId: string, question: string, options: CreateQuestionOptions = {}): PendingQuestion {
    const choices = copiedChoices(options.choices)
    const entry: OpenEntry = {
      questionId: this.newId(),
      agentId,
      question,
      createdAt: this.now(),
      waiters: new Set(),
      ...(choices ? { choices } : {}),
      ...(options.deliverAnswer ? { deliverAnswer: options.deliverAnswer } : {})
    }
    this.open.set(entry.questionId, entry)
    this.notifyMutation()
    return publicQuestion(entry)
  }

  /**
   * Every currently unanswered question, oldest first. Succession packages
   * the full list so a successor can drain the backlog; {@link openForAgent}
   * is still the one-question-at-a-time view.
   */
  listOpen(): PendingQuestion[] {
    return [...this.open.values()].map(publicQuestion)
  }

  get(questionId: string): PendingQuestion | undefined {
    const entry = this.open.get(questionId)
    return entry ? publicQuestion(entry) : undefined
  }

  /** The agent's currently unanswered question, if any (oldest first). */
  openForAgent(agentId: string): PendingQuestion | undefined {
    for (const entry of this.open.values()) {
      if (entry.agentId === agentId) return publicQuestion(entry)
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

  /**
   * Answer a question: wake every parked caller. Returns the closed entry
   * (including `deliverAnswer` when set) so the MCP layer can await PTY
   * delivery. Returns undefined if unknown. Stays synchronous.
   */
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
    this.notifyMutation()
    return publicQuestion(entry)
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
    if (cancelled > 0) this.notifyMutation()
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
