import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HandoffHandshakeRegistry,
  type HandoffAgentIdentity,
  type HandoffChallenge,
  type HandoffClientIdentity,
  type HandoffContextDelivered
} from './handoffHandshake'

const source: HandoffAgentIdentity = {
  agentId: 'orch-source',
  name: 'Glaurung',
  profileId: 'profile-1',
  workspaceSessionId: 'session-1',
  engineId: 'engine-1'
}

const target: HandoffAgentIdentity = {
  agentId: 'orch-target',
  name: 'Faramir',
  profileId: 'profile-1',
  workspaceSessionId: 'session-1',
  engineId: 'engine-1'
}

const targetClient: HandoffClientIdentity = {
  agentId: target.agentId,
  profileId: target.profileId,
  workspaceSessionId: target.workspaceSessionId,
  engineId: target.engineId
}

const registries: HandoffHandshakeRegistry[] = []

function registry(onAccepted = vi.fn()): {
  value: HandoffHandshakeRegistry
  onAccepted: ReturnType<typeof vi.fn>
} {
  const value = new HandoffHandshakeRegistry({ onAccepted })
  registries.push(value)
  return { value, onAccepted }
}

function begin(value: HandoffHandshakeRegistry, timeoutMs = 10_000): HandoffChallenge {
  return value.begin({
    source,
    target,
    briefingPath: 'C:\\handoffs\\handoff.md',
    briefing: '# Exact handoff knowledge',
    timeoutMs
  })
}

function deliver(
  value: HandoffHandshakeRegistry,
  challenge: HandoffChallenge,
  identity: HandoffClientIdentity = targetClient
): HandoffContextDelivered {
  const result = value.readContext(challenge, identity, {
    snapshot: { engineId: 'engine-1', goal: { title: 'Continue safely' } },
    tasks: [{ id: 'task-1', status: 'running' }]
  })
  expect(result.ok).toBe(true)
  return result as HandoffContextDelivered
}

afterEach(() => {
  for (const value of registries.splice(0)) value.dispose()
  vi.useRealTimers()
})

describe('HandoffHandshakeRegistry', () => {
  it('shuts down only after the exact context was delivered and explicitly acknowledged', async () => {
    const { value, onAccepted } = registry()
    const challenge = begin(value)
    const context = deliver(value, challenge)

    const result = await value.acknowledge(
      {
        ...challenge,
        knowledgeDigest: context.knowledgeDigest,
        summary: 'Ich übernehme das aktive Ziel und den laufenden Task task-1.'
      },
      targetClient
    )

    expect(result).toEqual({ ok: true, duplicate: false, phase: 'completed' })
    expect(onAccepted).toHaveBeenCalledOnce()
    expect(value.snapshot(challenge.handoffId)?.phase).toBe('completed')
  })

  it('treats an exact duplicate acknowledgement as idempotent', async () => {
    const { value, onAccepted } = registry()
    const challenge = begin(value)
    const context = deliver(value, challenge)
    const acknowledgement = {
      ...challenge,
      knowledgeDigest: context.knowledgeDigest,
      summary: 'Ich übernehme das aktive Ziel und alle laufenden Tasks.'
    }

    await expect(value.acknowledge(acknowledgement, targetClient)).resolves.toMatchObject({
      ok: true,
      duplicate: false
    })
    await expect(value.acknowledge(acknowledgement, targetClient)).resolves.toEqual({
      ok: true,
      duplicate: true,
      phase: 'completed'
    })
    expect(onAccepted).toHaveBeenCalledOnce()
  })

  it('rejects acknowledgement before the target retrieved the knowledge context', async () => {
    const { value, onAccepted } = registry()
    const challenge = begin(value)

    await expect(
      value.acknowledge(
        {
          ...challenge,
          knowledgeDigest: 'a'.repeat(64),
          summary: 'Ich behaupte den Stand zu kennen.'
        },
        targetClient
      )
    ).resolves.toMatchObject({ ok: false, code: 'context-not-read' })
    expect(onAccepted).not.toHaveBeenCalled()
  })

  it('rejects an incomplete knowledge acknowledgement', async () => {
    const { value, onAccepted } = registry()
    const challenge = begin(value)
    const context = deliver(value, challenge)

    await expect(
      value.acknowledge(
        {
          ...challenge,
          knowledgeDigest: context.knowledgeDigest,
          summary: 'ok'
        },
        targetClient
      )
    ).resolves.toMatchObject({ ok: false, code: 'incomplete-acknowledgement' })
    expect(onAccepted).not.toHaveBeenCalled()
  })

  it.each([
    ['foreign agent', { ...targetClient, agentId: 'orch-foreign' }, 'wrong-target'],
    ['stale session', { ...targetClient, workspaceSessionId: 'session-old' }, 'wrong-correlation'],
    ['wrong engine', { ...targetClient, engineId: 'engine-old' }, 'wrong-correlation'],
    ['foreign profile', { ...targetClient, profileId: 'profile-foreign' }, 'wrong-correlation']
  ])('rejects a %s identity', async (_label, identity, code) => {
    const { value, onAccepted } = registry()
    const challenge = begin(value)

    expect(value.readContext(challenge, identity, {})).toMatchObject({ ok: false, code })
    expect(onAccepted).not.toHaveBeenCalled()
  })

  it('rejects wrong tokens, digests and handoff ids without shutdown', async () => {
    const { value, onAccepted } = registry()
    const challenge = begin(value)

    expect(
      value.readContext({ ...challenge, receiptToken: '0'.repeat(64) }, targetClient, {})
    ).toMatchObject({ ok: false, code: 'wrong-token' })
    const context = deliver(value, challenge)
    await expect(
      value.acknowledge(
        {
          ...challenge,
          knowledgeDigest: 'f'.repeat(64),
          summary: 'Ich übernehme angeblich den vollständigen Stand.'
        },
        targetClient
      )
    ).resolves.toMatchObject({ ok: false, code: 'wrong-digest' })
    await expect(
      value.acknowledge(
        {
          ...challenge,
          handoffId: '00000000-0000-4000-8000-000000000000',
          knowledgeDigest: context.knowledgeDigest,
          summary: 'Ich übernehme angeblich den vollständigen Stand.'
        },
        targetClient
      )
    ).resolves.toMatchObject({ ok: false, code: 'unknown-handoff' })
    expect(onAccepted).not.toHaveBeenCalled()
  })

  it('keeps the source alive after timeout or target process loss', async () => {
    vi.useFakeTimers()
    const timed = registry()
    const timedChallenge = begin(timed.value, 50)
    const timedContext = deliver(timed.value, timedChallenge)
    await vi.advanceTimersByTimeAsync(51)

    await expect(
      timed.value.acknowledge(
        {
          ...timedChallenge,
          knowledgeDigest: timedContext.knowledgeDigest,
          summary: 'Diese Bestätigung kommt nach dem erlaubten Zeitfenster.'
        },
        targetClient
      )
    ).resolves.toMatchObject({ ok: false, code: 'handoff-failed' })
    expect(timed.onAccepted).not.toHaveBeenCalled()

    const exited = registry()
    const exitedChallenge = begin(exited.value)
    exited.value.markAgentUnavailable(target.agentId, 'Zielprozess beendet.')
    expect(exited.value.snapshot(exitedChallenge.handoffId)).toMatchObject({
      phase: 'failed',
      error: 'Zielprozess beendet.'
    })
    expect(exited.onAccepted).not.toHaveBeenCalled()
  })

  it('fails closed when confirmed source-process termination reports an error', async () => {
    const onAccepted = vi.fn().mockRejectedValue(new Error('taskkill failed'))
    const { value } = registry(onAccepted)
    const challenge = begin(value)
    const context = deliver(value, challenge)

    await expect(
      value.acknowledge(
        {
          ...challenge,
          knowledgeDigest: context.knowledgeDigest,
          summary: 'Ich übernehme den vollständigen Kontext, aber der Shutdown schlägt fehl.'
        },
        targetClient
      )
    ).resolves.toMatchObject({ ok: false, code: 'handoff-failed' })
    expect(value.snapshot(challenge.handoffId)).toMatchObject({
      phase: 'failed',
      error: expect.stringContaining('taskkill failed')
    })
  })

  it('serializes concurrent acknowledgements while source shutdown is in progress', async () => {
    let releaseShutdown: (() => void) | undefined
    const shutdown = new Promise<void>((resolve) => {
      releaseShutdown = resolve
    })
    const onAccepted = vi.fn(() => shutdown)
    const { value } = registry(onAccepted)
    const challenge = begin(value)
    const context = deliver(value, challenge)
    const acknowledgement = {
      ...challenge,
      knowledgeDigest: context.knowledgeDigest,
      summary: 'Ich übernehme das Ziel und den vollständigen Task-Zustand.'
    }

    const first = value.acknowledge(acknowledgement, targetClient)
    await expect(value.acknowledge(acknowledgement, targetClient)).resolves.toMatchObject({
      ok: false,
      code: 'handoff-completing'
    })
    releaseShutdown?.()
    await expect(first).resolves.toMatchObject({ ok: true, duplicate: false })
    expect(onAccepted).toHaveBeenCalledOnce()
  })

  it('requires a refreshed context when source output changes during the handshake race', async () => {
    const { value, onAccepted } = registry()
    const challenge = begin(value)
    const first = value.readContext(challenge, targetClient, { tasks: [] }, 'source-v1')
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.message)

    await expect(
      value.acknowledge(
        {
          ...challenge,
          knowledgeDigest: first.knowledgeDigest,
          summary: 'Ich übernehme den zunächst gelieferten Wissensstand.'
        },
        targetClient,
        'source-v2'
      )
    ).resolves.toMatchObject({ ok: false, code: 'context-changed' })
    expect(onAccepted).not.toHaveBeenCalled()

    const refreshed = value.readContext(
      challenge,
      targetClient,
      { tasks: [{ id: 'new-task' }] },
      'source-v2',
      '# Refreshed handoff knowledge'
    )
    expect(refreshed.ok).toBe(true)
    if (!refreshed.ok) throw new Error(refreshed.message)
    expect(refreshed.knowledgeDigest).not.toBe(first.knowledgeDigest)
    expect(refreshed.context.briefing).toBe('# Refreshed handoff knowledge')

    await expect(
      value.acknowledge(
        {
          ...challenge,
          knowledgeDigest: refreshed.knowledgeDigest,
          summary: 'Ich übernehme nun auch den aktualisierten Quellzustand.'
        },
        targetClient,
        'source-v2'
      )
    ).resolves.toMatchObject({ ok: true, duplicate: false })
    expect(onAccepted).toHaveBeenCalledOnce()
  })
})
