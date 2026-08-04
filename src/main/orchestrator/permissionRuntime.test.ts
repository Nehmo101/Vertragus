import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE } from '@shared/profile'
import type { AutoPrOutcome, PrepareTaskResult, RemoteCiOutcome } from '@main/integrations/autoPr'
import type { TaskRecoveryArtifact } from '@shared/orchestrator'

vi.mock('electron', () => ({
  app: { getPath: () => '.', getName: () => 'test', isPackaged: false },
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() }
}))

vi.mock('@main/windows', () => ({ createPaneWindow: vi.fn(), broadcast: vi.fn() }))
vi.mock('@main/config/store', () => ({
  getProfile: () => DEFAULT_PROFILE,
  getActiveProfileId: () => 'default',
  getSetting: () => undefined,
  setSetting: vi.fn()
}))

const {
  runTask,
  kill,
  prepareTaskChange,
  publishPreparedChanges,
  captureTaskRecoveryArtifact,
  enqueueRetroExport,
  enqueueBenchmarkExport
} = vi.hoisted(() => ({
  runTask: vi.fn(),
  kill: vi.fn(async () => undefined),
  // Diff-Guard: ein leerer Diff gilt nicht mehr als Erfolg, daher liefert der
  // Standard-Mock einen verifizierten Commit; No-Diff-Tests überschreiben ihn.
  prepareTaskChange: vi.fn<(input: unknown) => Promise<PrepareTaskResult>>(async (input) => {
    const { taskId = 'task', title = 'Task' } = (input ?? {}) as { taskId?: string; title?: string }
    return {
      status: 'prepared',
      result: 'committed',
      noChanges: false,
      message: 'Commit verifiziert.',
      branch: 'orca/default',
      worktree: '.',
      change: {
        taskId, title, worktree: '.', branch: 'orca/default',
        commit: 'd'.repeat(40), commits: ['d'.repeat(40)], files: ['feature.ts']
      }
    }
  }),
  publishPreparedChanges: vi.fn<(
    input: { onRemoteCiUpdate?: (outcome: RemoteCiOutcome) => void }
  ) => Promise<AutoPrOutcome>>(),
  captureTaskRecoveryArtifact: vi.fn<(input: unknown) => Promise<TaskRecoveryArtifact | undefined>>(async () => undefined),
  enqueueRetroExport: vi.fn(),
  enqueueBenchmarkExport: vi.fn()
}))
vi.mock('@main/agents/AgentManager', () => ({
  agentManager: { runTask, kill, list: () => [] }
}))
vi.mock('@main/integrations/autoPr', () => ({
  prepareTaskChange,
  publishPreparedChanges
}))
vi.mock('@main/orchestrator/recoveryArtifact', () => ({
  captureTaskRecoveryArtifact
}))
vi.mock('@main/orchestrator/retroExport', () => ({
  enqueueRetroExport,
  enqueueBenchmarkExport
}))

import { OrchestratorEngine } from './Engine'
import { permissionBroker } from '@main/permissions/PermissionBroker'

// Seit Yolo default AN ist, brauchen die Permission-Szenarien ein explizites
// Safe-Mode-Profil — sonst laufen die Worker ohne Freigabe-Prompts.
const SAFE_PROFILE = {
  ...DEFAULT_PROFILE,
  yoloDefault: false,
  agents: DEFAULT_PROFILE.agents.map((slot) => ({ ...slot, yolo: false }))
}

function info(taskId: string) {
  return {
    id: `agent-${taskId}`,
    name: 'Caronte',
    provider: 'codex' as const,
    model: '',
    role: 'Task · worker',
    kind: 'sub' as const,
    mode: 'task' as const,
    taskId,
    yolo: false,
    workingDir: '.',
    worktree: '.',
    status: 'running' as const,
    startedAt: Date.now()
  }
}

function permissionContext(engine: OrchestratorEngine, taskId: string, sessionId: string) {
  return {
    provider: 'codex' as const,
    agentId: `agent-${taskId}`,
    taskId,
    profileId: DEFAULT_PROFILE.id,
    workspaceSessionId: sessionId,
    engineId: engine.engineId,
    yolo: false
  }
}

describe('runtime permission handling (Retro-Fixes Lauf 2/3)', () => {
  it('propagates the runtime yolo master: pending prompts allow, future dispatches run yolo', async () => {
    let finish!: (value: { result: string; isError: boolean; status: 'succeeded' }) => void
    runTask.mockImplementationOnce(async (request) => ({
      info: info(request.taskId),
      done: new Promise((resolve) => { finish = resolve })
    }))
    const engine = new OrchestratorEngine({
      profile: { ...SAFE_PROFILE }, workspaceSessionId: 'yolo-session'
    })
    const accepted = engine.dispatchAsync('codex', 'Guarded work', 'Yolo runtime')
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('running'))

    const decision = permissionBroker.requestDecision(
      permissionContext(engine, accepted.taskId, 'yolo-session'), 'write'
    )
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('waiting'))

    expect(engine.setYolo(true)).toBe(true)
    await expect(decision).resolves.toBe('allow')
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('running'))

    // Laufende Worker behalten ihren Permission-Hook; er bekommt jetzt Auto-Allow.
    await expect(engine.requestToolPermission(accepted.taskId, 'edit')).resolves.toBe(true)
    expect(engine.snapshot().pendingPermissions ?? []).toHaveLength(0)

    finish({ result: 'ERGEBNIS: ERFOLG', isError: false, status: 'succeeded' })
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('success'))

    // Neue Dispatches derselben laufenden Session binden YOLO aus dem Rebind.
    runTask.mockImplementationOnce(async (request) => ({
      info: { ...info(request.taskId), yolo: request.yolo },
      done: Promise.resolve({ result: 'Done', isError: false, status: 'succeeded' as const })
    }))
    const next = engine.dispatchAsync('codex', 'Follow-up', 'Yolo dispatch')
    await vi.waitFor(() => expect(engine.getTaskStatus(next.taskId)?.status).toBe('success'))
    expect(runTask.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ yolo: true }))
  })

  it('never scores a no-changes completion as success when tool permissions were denied', async () => {
    let finish!: (value: { result: string; isError: boolean; status: 'succeeded' }) => void
    runTask.mockImplementationOnce(async (request) => ({
      info: info(request.taskId),
      done: new Promise((resolve) => { finish = resolve })
    }))
    const engine = new OrchestratorEngine({
      profile: { ...SAFE_PROFILE }, workspaceSessionId: 'denied-session'
    })
    // Der Worker konnte nie schreiben: die Abnahme findet keinerlei Änderungen.
    prepareTaskChange.mockResolvedValueOnce({
      status: 'skipped',
      result: 'no-changes',
      noChanges: true,
      message: 'No-op bestätigt.'
    })
    const accepted = engine.dispatchAsync('codex', 'Write contracts', 'Contracts')
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('running'))

    const decision = permissionBroker.requestDecision(
      permissionContext(engine, accepted.taskId, 'denied-session'), 'write'
    )
    await vi.waitFor(() => expect(engine.snapshot().pendingPermissions?.length).toBe(1))
    const pending = engine.snapshot().pendingPermissions![0]
    expect(engine.resolvePermission(pending.id, false)).toBe(true)
    await expect(decision).resolves.toBe('deny')

    // Retro Lauf 2: Der Worker endet "erfolgreich" ohne Änderungen ("Timer läuft"),
    // konnte aber nie schreiben — das darf kein success/no-changes werden.
    finish({ result: 'Timer läuft — teste Schreibzugriff erneut', isError: false, status: 'succeeded' })
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('error'))
    const status = engine.getTaskStatus(accepted.taskId)
    expect(status?.failureKind).toBe('infrastructure')
    expect(status?.completion).toBeUndefined()
    expect(status?.blocker).toEqual(expect.objectContaining({ code: 'permission-denied-no-changes' }))
  })

  it('fails fast with a structured blocker after consecutive permission-prompt timeouts', async () => {
    let finish!: (value: { result: string; isError: boolean; status: 'cancelled' }) => void
    runTask.mockImplementationOnce(async (request) => ({
      info: info(request.taskId),
      done: new Promise((resolve) => { finish = resolve })
    }))
    kill.mockImplementationOnce(async () => {
      finish({ result: 'Vertragus permission stop', isError: true, status: 'cancelled' })
    })
    const engine = new OrchestratorEngine({
      profile: { ...SAFE_PROFILE }, workspaceSessionId: 'storm-session'
    })
    const accepted = engine.dispatchAsync('codex', 'Blocked work', 'Storm')
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('running'))

    for (let round = 0; round < 3; round += 1) {
      const decision = permissionBroker.requestDecision(
        permissionContext(engine, accepted.taskId, 'storm-session'), 'write'
      )
      await vi.waitFor(() => expect(engine.snapshot().pendingPermissions?.length).toBe(1))
      const pending = engine.snapshot().pendingPermissions![0]
      permissionBroker.resolve(pending.id, 'deny', 'timeout')
      await expect(decision).resolves.toBe('deny')
    }

    // Retro Lauf 3: statt ~22 Minuten Retry-Diagnostik stoppt die Engine den
    // Worker nach dem dritten Timeout-Deny mit einem strukturierten Blocker.
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('error'))
    const status = engine.getTaskStatus(accepted.taskId)
    expect(status?.failureKind).toBe('infrastructure')
    expect(status?.blocker).toEqual(expect.objectContaining({ code: 'permission-starved' }))
    expect(status?.judgeReason).toContain('Permission-Blocker')
    expect(kill).toHaveBeenCalledWith(`agent-${accepted.taskId}`)
  })

  it('keeps explicit denies below the limit from stopping the worker', async () => {
    const killCallsBefore = kill.mock.calls.length
    let finish!: (value: { result: string; isError: boolean; status: 'succeeded' }) => void
    runTask.mockImplementationOnce(async (request) => ({
      info: info(request.taskId),
      done: new Promise((resolve) => { finish = resolve })
    }))
    const engine = new OrchestratorEngine({
      profile: { ...SAFE_PROFILE }, workspaceSessionId: 'mixed-session'
    })
    const accepted = engine.dispatchAsync('codex', 'Mixed decisions', 'Mixed')
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('running'))

    // Timeout, explizite Antwort, Timeout: die Timeout-Serie reißt ab — kein Stopp.
    for (const reason of ['timeout', 'explicit', 'timeout'] as const) {
      const decision = permissionBroker.requestDecision(
        permissionContext(engine, accepted.taskId, 'mixed-session'), 'write'
      )
      await vi.waitFor(() => expect(engine.snapshot().pendingPermissions?.length).toBe(1))
      const pending = engine.snapshot().pendingPermissions![0]
      permissionBroker.resolve(pending.id, reason === 'explicit' ? 'allow' : 'deny', reason)
      await decision
    }
    expect(kill.mock.calls.length).toBe(killCallsBefore)
    expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('running')

    // Ein belegter Commit bleibt trotz früherer Denials ein Erfolg — nur der
    // beleglose no-changes-Abschluss wird demotet.
    prepareTaskChange.mockResolvedValueOnce({
      status: 'prepared',
      result: 'committed',
      noChanges: false,
      message: 'Commit verified.',
      branch: 'orca/mixed',
      worktree: '.',
      change: {
        taskId: accepted.taskId,
        title: 'Mixed',
        worktree: '.',
        branch: 'orca/mixed',
        commit: 'b'.repeat(40),
        commits: ['b'.repeat(40)],
        files: ['mixed.ts']
      }
    })
    finish({ result: 'ERGEBNIS: ERFOLG', isError: false, status: 'succeeded' })
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('success'))
    expect(engine.getTaskStatus(accepted.taskId)?.completion).toEqual({ kind: 'commit', commit: 'b'.repeat(40) })
  })

  it('flags a long-open tool approval via watchdog without killing the waiting worker', async () => {
    const killCallsBefore = kill.mock.calls.length
    let finish!: (value: { result: string; isError: boolean; status: 'succeeded' }) => void
    runTask.mockImplementationOnce(async (request) => ({
      info: info(request.taskId),
      done: new Promise((resolve) => { finish = resolve })
    }))
    const engine = new OrchestratorEngine({
      profile: { ...SAFE_PROFILE },
      workspaceSessionId: 'watchdog-session',
      permissionApprovalTimeoutMs: 40
    })
    const accepted = engine.dispatchAsync('codex', 'Gate-Kette ausführen', 'Watchdog')
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('running'))

    const decision = permissionBroker.requestDecision(
      permissionContext(engine, accepted.taskId, 'watchdog-session'), 'bash'
    )
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('waiting'))

    // Retro: qa-gate-runner blieb unbegrenzt in 'Wartet auf Tool-Freigabe'.
    // Der Watchdog markiert den Task nach Ablauf des Fensters sichtbar …
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gate: 'permission', code: 'approval-timeout' })
      ])
    ))
    // … ohne den Worker zu stoppen: die Freigabe bleibt offen und beantwortbar.
    expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('waiting')
    expect(engine.snapshot().pendingPermissions).toHaveLength(1)
    expect(kill.mock.calls.length).toBe(killCallsBefore)

    const pending = engine.snapshot().pendingPermissions![0]
    expect(engine.resolvePermission(pending.id, true)).toBe(true)
    await expect(decision).resolves.toBe('allow')
    finish({ result: 'ERGEBNIS: ERFOLG', isError: false, status: 'succeeded' })
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('success'))
  })
})
