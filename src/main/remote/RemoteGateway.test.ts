import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteCommandDependencies } from './commands'
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

function commandRouter(): RemoteCommandRouter {
  const deps: RemoteCommandDependencies = {
    reviewPlan: vi.fn(), enableAutoMode: vi.fn(), reset: vi.fn(),
    submitGoal: vi.fn(), approvePublication: vi.fn(), rejectPublication: vi.fn(),
    taskDiff: vi.fn(), resolvePermission: vi.fn(), setBudgetCaps: vi.fn(),
    pauseTask: vi.fn(), resumeTask: vi.fn(), fallbackTask: vi.fn(), replanPending: vi.fn(),
    activateKillSwitch: vi.fn()
  }
  return new RemoteCommandRouter(deps)
}

// Raw HTTP GET that preserves the request-target verbatim (no client-side URL
// normalisation), so path-traversal payloads reach the server as written.
function rawGet(origin: string, path: string): Promise<{ status: number; body: string }> {
  const target = new URL(origin)
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: target.hostname, port: target.port, path, method: 'GET' },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8')
        }))
      }
    )
    req.once('error', reject)
    req.end()
  })
}

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
        pauseTask: vi.fn(), resumeTask: vi.fn(), fallbackTask: vi.fn(), replanPending: vi.fn(),
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
        resumeTask: vi.fn(), fallbackTask: vi.fn(), replanPending: vi.fn(), activateKillSwitch: vi.fn()
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

describe('RemoteGateway serveStatic hardening', () => {
  const SECRET = 'TOP_SECRET_CONTENTS_9f83c1a2'

  async function startStaticGateway(): Promise<{
    gateway: Awaited<ReturnType<typeof startRemoteGateway>>
    staticDir: string
  }> {
    const baseDir = mkdtempSync(join(tmpdir(), 'orca-static-test-'))
    directories.push(baseDir)
    // Secret file lives OUTSIDE the static root, one level up.
    writeFileSync(join(baseDir, 'secret.txt'), SECRET)
    const staticDir = join(baseDir, 'public')
    mkdirSync(staticDir)
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>INDEX_MARKER</title>')
    writeFileSync(join(staticDir, 'app.js'), 'console.log("APP_MARKER")')
    const gateway = await startRemoteGateway({
      auth: new DeviceAuth(new MemoryStore()),
      readModel: new RemoteReadModel(new EventEmitter()),
      audit: new RemoteAuditLog(join(baseDir, 'audit.jsonl')),
      commands: commandRouter(),
      staticDir
    })
    return { gateway, staticDir }
  }

  it('serves a normal file inside the static root (guard is not blanket-deny)', async () => {
    const { gateway } = await startStaticGateway()
    try {
      const index = await rawGet(gateway.origin, '/')
      expect(index.status).toBe(200)
      expect(index.body).toContain('INDEX_MARKER')

      const script = await rawGet(gateway.origin, '/app.js')
      expect(script.status).toBe(200)
      expect(script.body).toContain('APP_MARKER')
    } finally {
      await gateway.close()
    }
  })

  it('never lets a path-traversal payload escape the static root', async () => {
    const { gateway } = await startStaticGateway()
    try {
      const payloads = [
        '/../secret.txt',            // literal dot-dot (URL layer normalises it away)
        '/%2e%2e%2fsecret.txt',      // percent-encoded ../  (decoded inside serveStatic)
        '/%2e%2e%2f%2e%2e%2fsecret.txt', // deeper percent-encoded traversal
        '/%2f%2e%2e%2fsecret.txt',   // percent-encoded leading-slash + ../
        '/..%5c..%5csecret.txt'      // backslash variant
      ]
      for (const payload of payloads) {
        const response = await rawGet(gateway.origin, payload)
        // Secure behaviour: either 404, or a safe fall-back to index.html (200).
        expect([200, 404]).toContain(response.status)
        // The critical invariant: the out-of-root secret must never leak.
        expect(response.body).not.toContain(SECRET)
      }
    } finally {
      await gateway.close()
    }
  })

  it('returns a normal HTTP error (not a hang/crash) for a malformed percent-escape', async () => {
    const { gateway } = await startStaticGateway()
    try {
      const response = await rawGet(gateway.origin, '/%zz')
      // decodeURIComponent throws on the bad escape; the server catches it and
      // responds with an ordinary error status instead of hanging or crashing.
      expect([400, 404, 500]).toContain(response.status)
      expect(response.body).not.toContain(SECRET)
    } finally {
      await gateway.close()
    }
  })
})

describe('RemoteGateway API authorization', () => {
  it('rejects /stream with 401 (no/invalid bearer) and 403 (valid token lacking read scope)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-authz-test-'))
    directories.push(directory)
    const auth = new DeviceAuth(new MemoryStore())
    const gateway = await startRemoteGateway({
      auth,
      readModel: new RemoteReadModel(new EventEmitter()),
      audit: new RemoteAuditLog(join(directory, 'audit.jsonl')),
      commands: commandRouter()
    })
    // A device paired with only the 'steer' capability authenticates successfully
    // but lacks the 'read' capability that /stream requires.
    const paired = auth.pair(
      auth.startPairing(['steer'], undefined, { id: 'owner', displayName: 'Owner' }).code,
      'Phone'
    )!
    expect(paired.device.capabilities).not.toContain('read')
    try {
      const noAuth = await fetch(`${gateway.origin}/stream`)
      expect(noAuth.status).toBe(401)

      const badAuth = await fetch(`${gateway.origin}/stream`, {
        headers: { Authorization: 'Bearer bogusTokenThatIsNotReal' }
      })
      expect(badAuth.status).toBe(401)

      const noCapability = await fetch(`${gateway.origin}/stream`, {
        headers: { Authorization: `Bearer ${paired.token}` }
      })
      expect(noCapability.status).toBe(403)
    } finally {
      await gateway.close()
    }
  })
})

describe('RemoteGateway pairing rate limit', () => {
  it('returns 429 once the pairing rate limit is exhausted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-pair-rl-test-'))
    directories.push(directory)
    const gateway = await startRemoteGateway({
      auth: new DeviceAuth(new MemoryStore()),
      readModel: new RemoteReadModel(new EventEmitter()),
      audit: new RemoteAuditLog(join(directory, 'audit.jsonl')),
      commands: commandRouter()
    })
    try {
      const statuses: number[] = []
      // Pair limiter is capacity 5; the 6th attempt from the same client key
      // (all loopback requests share `ip:127.0.0.1`) must be rate limited.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await fetch(`${gateway.origin}/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'wrong-code', deviceName: 'Phone' })
        })
        statuses.push(response.status)
      }
      // First attempts pass the limiter but fail the (wrong) code -> 401.
      expect(statuses[0]).toBe(401)
      expect(statuses.slice(0, 5)).not.toContain(429)
      // The attempt beyond capacity is refused before the body is even parsed.
      expect(statuses[5]).toBe(429)
    } finally {
      await gateway.close()
    }
  })
})
