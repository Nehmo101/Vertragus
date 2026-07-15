import { EventEmitter } from 'node:events'
import { app } from 'electron'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentInstanceInfo } from '@shared/agents'
import { DEFAULT_PROFILE } from '@shared/profile'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import { agentManager } from '@main/agents/AgentManager'
import { OrchestratorEngine } from '@main/orchestrator/Engine'
import { RemoteAuditLog } from './auditLog'
import { RemoteCommandRouter } from './commands'
import { DeviceAuth } from './deviceAuth'
import type { DeviceRecordStore, StoredDeviceRecord } from './deviceStore'
import { startRemoteGateway } from './RemoteGateway'
import { RemoteReadModel } from './readModel'

class MemoryDeviceStore implements DeviceRecordStore {
  private records: StoredDeviceRecord[] = []
  load(): StoredDeviceRecord[] { return this.records.map((record) => ({ ...record, capabilities: [...record.capabilities] })) }
  save(records: StoredDeviceRecord[]): void { this.records = records.map((record) => ({ ...record, capabilities: [...record.capabilities] })) }
}

function report(ok: boolean, text: string): boolean {
  console.log(`[REMOTE SELFTEST] ${ok ? 'PASS' : 'FAIL'} — ${text}`)
  return ok
}

export async function runRemoteSelfTest(): Promise<void> {
  let allOk = true
  const check = (condition: boolean, text: string): void => { if (!report(condition, text)) allOk = false }
  const directory = await mkdtemp(join(tmpdir(), 'orca-remote-selftest-'))
  const bus = new EventEmitter()
  const engine = new OrchestratorEngine({ profile: DEFAULT_PROFILE, workspaceSessionId: 'remote-selftest' })
  const mutableEngine = engine as OrchestratorEngine & { listSubagents: OrchestratorEngine['listSubagents'] }
  const originalListSubagents = mutableEngine.listSubagents
  const originalRunTask = agentManager.runTask
  let gateway: Awaited<ReturnType<typeof startRemoteGateway>> | undefined

  try {
    mutableEngine.listSubagents = () => [{
      role: 'codex', provider: 'codex', model: '', capacity: 1, busy: 0,
      strengths: [], weaknesses: [], available: true
    }]
    agentManager.runTask = async (request) => {
      const info: AgentInstanceInfo = {
        id: `remote-${request.taskId}`,
        profileId: DEFAULT_PROFILE.id,
        workspaceSessionId: 'remote-selftest',
        engineId: engine.engineId,
        name: 'Remote-Testagent',
        provider: request.provider,
        model: request.model,
        role: request.role,
        kind: 'sub', mode: 'task', taskId: request.taskId,
        yolo: false, workingDir: process.cwd(), status: 'running', startedAt: Date.now()
      }
      return { info, done: Promise.resolve({ result: 'REMOTE-STUB', isError: false }) }
    }
    engine.on('snapshot', (snapshot: OrchestratorSnapshot) => bus.emit('snapshot', snapshot))

    const readModel = new RemoteReadModel(bus)
    readModel.start()
    const auth = new DeviceAuth(new MemoryDeviceStore())
    const auditPath = join(directory, 'audit.jsonl')
    const audit = new RemoteAuditLog(auditPath)
    const commands = new RemoteCommandRouter({
      reviewPlan: (_profileId, approved, sessionId) => sessionId === 'remote-selftest' && engine.reviewPlan(approved),
      enableAutoMode: () => engine.enableAutoMode(),
      reset: () => engine.reset(),
      submitGoal: () => ({ accepted: true, yoloMaster: false }),
      activateKillSwitch: () => auth.revokeAll()
    })
    gateway = await startRemoteGateway({ auth, audit, commands, readModel })

    const unauthorized = await fetch(`${gateway.origin}/stream`)
    check(unauthorized.status === 401, 'unauthenticated stream is rejected with 401')

    const challenge = auth.startPairing(['read', 'steer'])
    const pairResponse = await fetch(`${gateway.origin}/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: challenge.code, deviceName: 'Selftest Phone' })
    })
    const paired = await pairResponse.json() as { token: string; device: { id: string } }
    check(pairResponse.status === 200 && Boolean(paired.token), 'one-time pairing returns a bearer token once')
    const badToken = await fetch(`${gateway.origin}/devices`, { headers: { Authorization: 'Bearer invalid-token' } })
    check(badToken.status === 401, 'invalid bearer token is rejected')

    engine.executePlanAsync({
      version: 1, goal: 'Remote approval selftest', maxParallel: 1,
      tasks: [{
        id: 'verify', title: 'Verify remote approval', role: 'codex', prompt: 'test',
        dependsOn: [], advisoryDependsOn: [], criticality: 'required', conflictKeys: [],
        ownership: 'feature', expectedFiles: []
      }]
    })
    for (let attempt = 0; attempt < 100 && !engine.snapshot().pendingPlan; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    check(Boolean(engine.snapshot().pendingPlan), 'real engine reaches pendingPlan review gate')

    const streamController = new AbortController()
    const streamResponse = await fetch(`${gateway.origin}/stream`, {
      headers: { Authorization: `Bearer ${paired.token}` }, signal: streamController.signal
    })
    const firstChunk = await streamResponse.body?.getReader().read()
    const streamText = firstChunk?.value ? new TextDecoder().decode(firstChunk.value) : ''
    check(streamResponse.status === 200 && streamText.includes('pendingPlan'), 'pendingPlan is projected through authenticated SSE')

    const approval = await fetch(`${gateway.origin}/command`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${paired.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'plan.approve', args: { profileId: DEFAULT_PROFILE.id, sessionId: 'remote-selftest' }
      })
    })
    check(approval.status === 200 && !engine.snapshot().pendingPlan, 'plan.approve resolves the existing engine gate')

    auth.revoke(paired.device.id)
    const revoked = await fetch(`${gateway.origin}/devices`, { headers: { Authorization: `Bearer ${paired.token}` } })
    check(revoked.status === 401, 'revoked device is rejected and its SSE connection is dropped')
    streamController.abort()

    const auditText = await readFile(auditPath, 'utf8')
    check(!auditText.includes(paired.token) && auditText.includes('plan.approve'), 'audit contains action but no raw bearer token')
  } catch (error) {
    check(false, error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    mutableEngine.listSubagents = originalListSubagents
    agentManager.runTask = originalRunTask
    await gateway?.close()
    await rm(directory, { recursive: true, force: true })
  }

  console.log(`[REMOTE SELFTEST] ${allOk ? 'ALL PASSED' : 'FAILURES PRESENT'}`)
  app.exit(allOk ? 0 : 1)
}

