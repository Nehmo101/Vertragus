import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteAuditLog } from './auditLog'
import { RemoteCommandRouter } from './commands'
import { DeviceAuth } from './deviceAuth'
import type { DeviceRecordStore, StoredDeviceRecord } from './deviceStore'
import { REMOTE_PAIR_BODY_CAP, startRemoteGateway } from './RemoteGateway'
import { RemoteReadModel } from './readModel'

class MemoryStore implements DeviceRecordStore {
  records: StoredDeviceRecord[] = []
  load(): StoredDeviceRecord[] { return this.records }
  save(records: StoredDeviceRecord[]): void { this.records = records }
}

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('RemoteGateway hardening', () => {
  it('binds loopback, rejects an unlisted Host, and caps request bodies', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-gateway-test-'))
    directories.push(directory)
    const gateway = await startRemoteGateway({
      auth: new DeviceAuth(new MemoryStore()),
      readModel: new RemoteReadModel(new EventEmitter()),
      audit: new RemoteAuditLog(join(directory, 'audit.jsonl')),
      commands: new RemoteCommandRouter({
        reviewPlan: vi.fn(), enableAutoMode: vi.fn(), reset: vi.fn(),
        submitGoal: vi.fn(), approvePublication: vi.fn(), rejectPublication: vi.fn(),
        taskDiff: vi.fn(), resolvePermission: vi.fn(), setBudgetCaps: vi.fn(),
        pauseTask: vi.fn(), resumeTask: vi.fn(), replanPending: vi.fn(),
        activateKillSwitch: vi.fn()
      })
    })
    try {
      expect(gateway.origin).toMatch(/^http:\/\/127\.0\.0\.1:/)
      const target = new URL(gateway.origin)
      const rebindingStatus = await new Promise<number>((resolve, reject) => {
        const req = request({
          hostname: target.hostname,
          port: target.port,
          path: '/health',
          headers: { Host: 'attacker.example' }
        }, (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        req.once('error', reject)
        req.end()
      })
      expect(rebindingStatus).toBe(421)
      const oversized = await fetch(`${gateway.origin}/pair`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'x'.repeat(REMOTE_PAIR_BODY_CAP + 1), deviceName: 'Phone' })
      })
      expect(oversized.status).toBe(413)
    } finally {
      await gateway.close()
    }
  })

  it('authenticates WebSocket upgrades with the same device bearer and rejects missing auth', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-ws-test-'))
    directories.push(directory)
    const auth = new DeviceAuth(new MemoryStore())
    const gateway = await startRemoteGateway({
      auth,
      readModel: new RemoteReadModel(new EventEmitter()),
      audit: new RemoteAuditLog(join(directory, 'audit.jsonl')),
      commands: new RemoteCommandRouter({
        reviewPlan: vi.fn(), enableAutoMode: vi.fn(), reset: vi.fn(), submitGoal: vi.fn(),
        approvePublication: vi.fn(), rejectPublication: vi.fn(), taskDiff: vi.fn(),
        resolvePermission: vi.fn(), setBudgetCaps: vi.fn(), pauseTask: vi.fn(),
        resumeTask: vi.fn(), replanPending: vi.fn(), activateKillSwitch: vi.fn()
      })
    })
    const paired = auth.pair(auth.startPairing(
      ['read'], undefined, { id: 'owner', displayName: 'Owner' },
      [{ profileId: 'p', sessionIds: ['s'], allowGoalSubmit: false }]
    ).code, 'Phone')!
    const upgrade = (protocol?: string): Promise<number> => new Promise((resolveStatus, reject) => {
      const target = new URL(gateway.origin)
      const req = request({
        hostname: target.hostname, port: target.port, path: '/ws',
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          ...(protocol ? { 'Sec-WebSocket-Protocol': protocol } : {})
        }
      })
      req.on('upgrade', (response, socket) => { socket.destroy(); resolveStatus(response.statusCode ?? 101) })
      req.on('response', (response) => { response.resume(); resolveStatus(response.statusCode ?? 0) })
      req.on('error', reject)
      req.end()
    })
    try {
      await expect(upgrade()).resolves.toBe(401)
      await expect(upgrade(`orca-v1, orca-bearer.${paired.token}`)).resolves.toBe(101)
    } finally {
      await gateway.close()
    }
  })
})
