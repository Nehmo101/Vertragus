import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { HandoffHandshakePhase } from '@shared/agents'

export const ORCHESTRATOR_HANDOFF_TIMEOUT_MS = 120_000
const SETTLED_RETENTION_MS = 5 * 60_000

export interface HandoffAgentIdentity {
  agentId: string
  name: string
  profileId?: string
  workspaceSessionId?: string
  engineId?: string
}

export interface HandoffClientIdentity {
  agentId: string
  profileId?: string
  workspaceSessionId?: string
  engineId?: string
}

export interface HandoffContextPayload {
  version: 1
  handoffId: string
  source: HandoffAgentIdentity
  target: HandoffAgentIdentity
  briefingPath: string
  briefing: string
  orchestratorState: unknown
  /** Digest of the source terminal state at delivery time. */
  sourceContinuity?: string
  deliveredAt: number
}

export interface HandoffHandshakeSnapshot {
  handoffId: string
  source: HandoffAgentIdentity
  target: HandoffAgentIdentity
  phase: HandoffHandshakePhase
  createdAt: number
  updatedAt: number
  error?: string
}

interface HandoffRecord extends HandoffHandshakeSnapshot {
  receiptToken: string
  briefingPath: string
  briefing: string
  timeout?: ReturnType<typeof setTimeout>
  context?: HandoffContextPayload
  knowledgeDigest?: string
  acknowledgementSummary?: string
  sourceContinuity?: string
  settledAt?: number
}

export interface HandoffHandshakeStart {
  source: HandoffAgentIdentity
  target: HandoffAgentIdentity
  briefingPath: string
  briefing: string
  timeoutMs?: number
}

export interface HandoffChallenge {
  handoffId: string
  receiptToken: string
}

export type HandoffRejectionCode =
  | 'unknown-handoff'
  | 'wrong-target'
  | 'wrong-correlation'
  | 'wrong-token'
  | 'context-not-read'
  | 'context-changed'
  | 'wrong-digest'
  | 'incomplete-acknowledgement'
  | 'handoff-failed'
  | 'handoff-completing'

export interface HandoffRejected {
  ok: false
  code: HandoffRejectionCode
  message: string
}

export interface HandoffContextDelivered {
  ok: true
  context: HandoffContextPayload
  knowledgeDigest: string
}

export interface HandoffAcknowledged {
  ok: true
  duplicate: boolean
  phase: 'completed'
}

export type HandoffContextResult = HandoffContextDelivered | HandoffRejected
export type HandoffAcknowledgementResult = HandoffAcknowledged | HandoffRejected

export interface HandoffAcknowledgement {
  handoffId: string
  receiptToken: string
  knowledgeDigest: string
  summary: string
}

export interface HandoffHandshakeOptions {
  now?: () => number
  onTransition?: (snapshot: HandoffHandshakeSnapshot) => void
  onAccepted?: (snapshot: HandoffHandshakeSnapshot) => Promise<void> | void
}

function secureEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function identityMatches(expected: HandoffAgentIdentity, actual: HandoffClientIdentity): boolean {
  return (
    expected.agentId === actual.agentId &&
    expected.profileId === actual.profileId &&
    expected.workspaceSessionId === actual.workspaceSessionId &&
    expected.engineId === actual.engineId
  )
}

function publicSnapshot(record: HandoffRecord): HandoffHandshakeSnapshot {
  return {
    handoffId: record.handoffId,
    source: { ...record.source },
    target: { ...record.target },
    phase: record.phase,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    error: record.error
  }
}

function rejection(code: HandoffRejectionCode, message: string): HandoffRejected {
  return { ok: false, code, message }
}

/**
 * In-memory, process-local state machine for an orchestrator handoff.
 *
 * A target must first retrieve the exact briefing + engine snapshot and then
 * acknowledge its digest from the correctly correlated MCP client identity.
 * Only that terminal transition invokes `onAccepted`, which owns source shutdown.
 */
export class HandoffHandshakeRegistry {
  private readonly records = new Map<string, HandoffRecord>()
  private readonly now: () => number
  private readonly onTransition?: (snapshot: HandoffHandshakeSnapshot) => void
  private readonly onAccepted?: (snapshot: HandoffHandshakeSnapshot) => Promise<void> | void

  constructor(options: HandoffHandshakeOptions = {}) {
    this.now = options.now ?? Date.now
    this.onTransition = options.onTransition
    this.onAccepted = options.onAccepted
  }

  assertCanStart(sourceId: string): void {
    this.pruneSettled()
    const active = [...this.records.values()].find(
      (record) =>
        record.source.agentId === sourceId &&
        record.phase !== 'completed' &&
        record.phase !== 'failed'
    )
    if (active) {
      throw new Error(`Für ${sourceId} läuft bereits eine Orchestrator-Übergabe.`)
    }
  }

  begin(input: HandoffHandshakeStart): HandoffChallenge {
    this.assertCanStart(input.source.agentId)
    const now = this.now()
    const record: HandoffRecord = {
      handoffId: randomUUID(),
      receiptToken: randomBytes(32).toString('hex'),
      source: { ...input.source },
      target: { ...input.target },
      briefingPath: input.briefingPath,
      briefing: input.briefing,
      phase: 'awaiting-context',
      createdAt: now,
      updatedAt: now
    }
    const timeoutMs = input.timeoutMs ?? ORCHESTRATOR_HANDOFF_TIMEOUT_MS
    record.timeout = setTimeout(() => {
      this.fail(record.handoffId, 'Zeitüberschreitung: Der neue Orchestrator hat die Übergabe nicht vollständig bestätigt.')
    }, timeoutMs)
    record.timeout.unref?.()
    this.records.set(record.handoffId, record)
    this.transitioned(record)
    return { handoffId: record.handoffId, receiptToken: record.receiptToken }
  }

  readContext(
    request: Pick<HandoffChallenge, 'handoffId' | 'receiptToken'>,
    identity: HandoffClientIdentity,
    orchestratorState: unknown,
    sourceContinuity?: string,
    latestBriefing?: string
  ): HandoffContextResult {
    const record = this.records.get(request.handoffId)
    const invalid = this.validateActive(record, request.receiptToken, identity)
    if (invalid) return invalid
    if (!record) return rejection('unknown-handoff', 'Übergabe nicht gefunden.')
    if (record.phase === 'completing') {
      return rejection('handoff-completing', 'Die bestätigte Übergabe wird bereits abgeschlossen.')
    }
    if (record.phase === 'completed') {
      if (!record.context || !record.knowledgeDigest) {
        return rejection('handoff-failed', 'Die abgeschlossene Übergabe besitzt keinen Kontextbeleg.')
      }
      return { ok: true, context: record.context, knowledgeDigest: record.knowledgeDigest }
    }
    if (
      record.context &&
      record.knowledgeDigest &&
      record.sourceContinuity === sourceContinuity
    ) {
      return { ok: true, context: record.context, knowledgeDigest: record.knowledgeDigest }
    }

    if (latestBriefing != null) record.briefing = latestBriefing
    const context: HandoffContextPayload = {
      version: 1,
      handoffId: record.handoffId,
      source: { ...record.source },
      target: { ...record.target },
      briefingPath: record.briefingPath,
      briefing: record.briefing,
      orchestratorState,
      sourceContinuity,
      deliveredAt: this.now()
    }
    record.context = context
    record.sourceContinuity = sourceContinuity
    record.knowledgeDigest = createHash('sha256').update(JSON.stringify(context)).digest('hex')
    record.phase = 'awaiting-ack'
    record.updatedAt = this.now()
    this.transitioned(record)
    return { ok: true, context, knowledgeDigest: record.knowledgeDigest }
  }

  async acknowledge(
    request: HandoffAcknowledgement,
    identity: HandoffClientIdentity,
    sourceContinuity?: string
  ): Promise<HandoffAcknowledgementResult> {
    const record = this.records.get(request.handoffId)
    const invalid = this.validateActive(record, request.receiptToken, identity)
    if (invalid) return invalid
    if (!record) return rejection('unknown-handoff', 'Übergabe nicht gefunden.')

    if (record.phase === 'completed') {
      if (!record.knowledgeDigest || !secureEqual(request.knowledgeDigest, record.knowledgeDigest)) {
        return rejection('wrong-digest', 'Die Wissensbestätigung gehört nicht zu diesem Übergabekontext.')
      }
      return { ok: true, duplicate: true, phase: 'completed' }
    }
    if (record.phase === 'completing') {
      return rejection('handoff-completing', 'Die bestätigte Übergabe wird bereits abgeschlossen.')
    }
    if (!record.context || !record.knowledgeDigest || record.phase === 'awaiting-context') {
      return rejection(
        'context-not-read',
        'Der neue Orchestrator muss den Übergabekontext zuerst vollständig abrufen.'
      )
    }
    if (record.sourceContinuity !== sourceContinuity) {
      record.context = undefined
      record.knowledgeDigest = undefined
      record.sourceContinuity = undefined
      record.phase = 'awaiting-context'
      record.updatedAt = this.now()
      this.transitioned(record)
      return rejection(
        'context-changed',
        'Der Quell-Orchestrator hat seit dem Kontextabruf neue Terminalinformationen erzeugt. Kontext erneut abrufen und erst danach bestätigen.'
      )
    }
    if (!secureEqual(request.knowledgeDigest, record.knowledgeDigest)) {
      return rejection('wrong-digest', 'Die Wissensbestätigung gehört nicht zu diesem Übergabekontext.')
    }
    const summary = request.summary.replace(/\s+/g, ' ').trim()
    if (summary.length < 8) {
      return rejection(
        'incomplete-acknowledgement',
        'Die Wissensbestätigung benötigt eine kurze Zusammenfassung des übernommenen Stands.'
      )
    }

    if (record.timeout) clearTimeout(record.timeout)
    record.timeout = undefined
    record.phase = 'completing'
    record.updatedAt = this.now()
    record.acknowledgementSummary = summary
    this.transitioned(record)

    try {
      await this.onAccepted?.(publicSnapshot(record))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.fail(record.handoffId, `Quell-Orchestrator konnte nicht sicher beendet werden: ${message}`)
      return rejection('handoff-failed', record.error ?? message)
    }

    record.phase = 'completed'
    record.updatedAt = this.now()
    record.settledAt = record.updatedAt
    this.transitioned(record)
    return { ok: true, duplicate: false, phase: 'completed' }
  }

  fail(handoffId: string, error: string): boolean {
    const record = this.records.get(handoffId)
    if (!record || record.phase === 'completed' || record.phase === 'failed') return false
    if (record.timeout) clearTimeout(record.timeout)
    record.timeout = undefined
    record.phase = 'failed'
    record.error = error
    record.updatedAt = this.now()
    record.settledAt = record.updatedAt
    this.transitioned(record)
    return true
  }

  markAgentUnavailable(agentId: string, reason: string): void {
    for (const record of this.records.values()) {
      if (
        record.phase !== 'completed' &&
        record.phase !== 'failed' &&
        record.phase !== 'completing' &&
        (record.source.agentId === agentId || record.target.agentId === agentId)
      ) {
        this.fail(record.handoffId, reason)
      }
    }
  }

  snapshot(handoffId: string): HandoffHandshakeSnapshot | undefined {
    const record = this.records.get(handoffId)
    return record ? publicSnapshot(record) : undefined
  }

  dispose(): void {
    for (const record of this.records.values()) {
      if (record.timeout) clearTimeout(record.timeout)
    }
    this.records.clear()
  }

  private validateActive(
    record: HandoffRecord | undefined,
    receiptToken: string,
    identity: HandoffClientIdentity
  ): HandoffRejected | undefined {
    if (!record) return rejection('unknown-handoff', 'Übergabe nicht gefunden oder bereits verworfen.')
    // Check the one-time secret before exposing any target/correlation detail.
    if (!secureEqual(receiptToken, record.receiptToken)) {
      return rejection('wrong-token', 'Der Übergabe-Beleg ist ungültig.')
    }
    if (!identityMatches(record.target, identity)) {
      const sameAgent = record.target.agentId === identity.agentId
      return rejection(
        sameAgent ? 'wrong-correlation' : 'wrong-target',
        sameAgent
          ? 'Workspace-, Session- oder Engine-Korrelation stimmt nicht mit der Übergabe überein.'
          : 'Diese Bestätigung stammt nicht vom vorgesehenen Ziel-Orchestrator.'
      )
    }
    if (record.phase === 'failed') {
      return rejection('handoff-failed', record.error ?? 'Die Übergabe ist fehlgeschlagen oder veraltet.')
    }
    return undefined
  }

  private transitioned(record: HandoffRecord): void {
    try {
      this.onTransition?.(publicSnapshot(record))
    } catch {
      // UI/event reporting must never weaken the shutdown safety boundary.
    }
  }

  private pruneSettled(): void {
    const cutoff = this.now() - SETTLED_RETENTION_MS
    for (const [id, record] of this.records) {
      if (record.settledAt != null && record.settledAt < cutoff) this.records.delete(id)
    }
  }
}
