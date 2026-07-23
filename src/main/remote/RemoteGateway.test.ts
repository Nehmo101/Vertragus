import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    const directory = mkdtempSync(join(tmpdir(), 'vertragus-gateway-test-'))
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
    const directory = mkdtempSync(join(tmpdir(), 'vertragus-ws-test-'))
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
    const upgrade = (
      protocol?: string,
      extraHeaders: Record<string, string> = {}
    ): Promise<{ status: number; protocol?: string }> => new Promise((resolveStatus, reject) => {
      const target = new URL(gateway.origin)
      const req = request({
        hostname: target.hostname, port: target.port, path: '/ws',
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          ...(protocol ? { 'Sec-WebSocket-Protocol': protocol } : {}),
          ...extraHeaders
        }
      })
      req.on('upgrade', (response, socket) => {
        socket.destroy()
        const negotiated = response.headers['sec-websocket-protocol']
        resolveStatus({
          status: response.statusCode ?? 101,
          protocol: Array.isArray(negotiated) ? negotiated[0] : negotiated
        })
      })
      req.on('response', (response) => { response.resume(); resolveStatus({ status: response.statusCode ?? 0 }) })
      req.on('error', reject)
      req.end()
    })
    try {
      await expect(upgrade()).resolves.toEqual({ status: 401 })
      // Legacy-only client (pre-rebrand mobile/iOS build) against new server.
      const legacy = await upgrade(`orca-v1, orca-bearer.${paired.token}`)
      expect(legacy).toEqual({ status: 101, protocol: 'orca-v1' })
      // New-only client.
      const canonical = await upgrade(`vertragus-v1, vertragus-bearer.${paired.token}`)
      expect(canonical).toEqual({ status: 101, protocol: 'vertragus-v1' })
      // Transition client offering both families: canonical version wins.
      const mixed = await upgrade(
        `vertragus-v1, orca-v1, vertragus-bearer.${paired.token}, orca-bearer.${paired.token}`
      )
      expect(mixed).toEqual({ status: 101, protocol: 'vertragus-v1' })
      // Bearer prefix and version may mix across families during rollout.
      const crossed = await upgrade(`orca-v1, vertragus-bearer.${paired.token}`)
      expect(crossed).toEqual({ status: 101, protocol: 'orca-v1' })
      // Garbage tokens stay rejected; an unknown version is never selected
      // (the upgrade completes without a subprotocol, so a conforming client
      // fails the connection on its side).
      await expect(upgrade('vertragus-bearer.short')).resolves.toEqual({ status: 401 })
      const unknown = await upgrade(`vertragus-v2, vertragus-bearer.${paired.token}`)
      expect(unknown.protocol).toBeUndefined()
      // Browser upgrade from an allowed origin still succeeds.
      const sameOrigin = await upgrade(
        `vertragus-v1, vertragus-bearer.${paired.token}`,
        { Origin: gateway.origin }
      )
      expect(sameOrigin).toEqual({ status: 101, protocol: 'vertragus-v1' })
      // Cross-site WebSocket hijacking: a valid bearer with a foreign Origin
      // is refused before authentication (403, not 401).
      const crossSite = await upgrade(
        `vertragus-v1, vertragus-bearer.${paired.token}`,
        { Origin: 'https://attacker.example' }
      )
      expect(crossSite.status).toBe(403)
      // Opaque ("null") and unparseable origins count as mismatches too.
      const nullOrigin = await upgrade(
        `vertragus-v1, vertragus-bearer.${paired.token}`,
        { Origin: 'null' }
      )
      expect(nullOrigin.status).toBe(403)
    } finally {
      await gateway.close()
    }
  })

  it('registers native APNs tokens on /push/apns and rejects malformed ones', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vertragus-apns-test-'))
    directories.push(directory)
    const auth = new DeviceAuth(new MemoryStore())
    const apnsCalls: Array<{ deviceId: string; input: unknown }> = []
    const pushService = {
      subscribeApns: (deviceId: string, input: unknown) => { apnsCalls.push({ deviceId, input }) }
    } as unknown as import('./pushService').PushService
    const gateway = await startRemoteGateway({
      auth,
      readModel: new RemoteReadModel(new EventEmitter()),
      audit: new RemoteAuditLog(join(directory, 'audit.jsonl')),
      commands: new RemoteCommandRouter({
        reviewPlan: vi.fn(), enableAutoMode: vi.fn(), reset: vi.fn(), submitGoal: vi.fn(),
        approvePublication: vi.fn(), rejectPublication: vi.fn(), taskDiff: vi.fn(),
        resolvePermission: vi.fn(), setBudgetCaps: vi.fn(), pauseTask: vi.fn(),
        resumeTask: vi.fn(), fallbackTask: vi.fn(), replanPending: vi.fn(), activateKillSwitch: vi.fn()
      }),
      pushService
    })
    const pushDevice = auth.pair(auth.startPairing(
      ['read', 'push'], undefined, { id: 'owner', displayName: 'Owner' },
      [{ profileId: 'p', sessionIds: ['s'], allowGoalSubmit: false }]
    ).code, 'Phone')!
    const readOnly = auth.pair(auth.startPairing(
      ['read'], undefined, { id: 'owner', displayName: 'Owner' }, []
    ).code, 'Reader')!
    const post = (token: string, body: unknown): Promise<Response> => fetch(`${gateway.origin}/push/apns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    })
    try {
      const ok = await post(pushDevice.token, {
        token: 'a'.repeat(64), environment: 'production', bundleId: 'com.example.App'
      })
      expect(ok.status).toBe(200)
      expect(apnsCalls).toHaveLength(1)
      expect(apnsCalls[0]!.input).toEqual({
        token: 'a'.repeat(64), environment: 'production', bundleId: 'com.example.App'
      })

      const malformed = await post(pushDevice.token, { token: 'nothex', environment: 'production', bundleId: 'com.example.App' })
      expect(malformed.status).toBe(400)

      const forbidden = await post(readOnly.token, { token: 'b'.repeat(64), environment: 'sandbox', bundleId: 'com.example.App' })
      expect(forbidden.status).toBe(403)

      expect(apnsCalls).toHaveLength(1)
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
    const baseDir = mkdtempSync(join(tmpdir(), 'vertragus-static-test-'))
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
    const directory = mkdtempSync(join(tmpdir(), 'vertragus-authz-test-'))
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

describe('RemoteGateway origin allowlist', () => {
  it('rejects HTTP requests whose Origin host is not allowlisted and audits the rejection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vertragus-origin-test-'))
    directories.push(directory)
    const auditPath = join(directory, 'audit.jsonl')
    const gateway = await startRemoteGateway({
      auth: new DeviceAuth(new MemoryStore()),
      readModel: new RemoteReadModel(new EventEmitter()),
      audit: new RemoteAuditLog(auditPath),
      commands: commandRouter()
    })
    try {
      // Same-origin browser request (Origin host equals the gateway host) passes.
      const sameOrigin = await fetch(`${gateway.origin}/health`, {
        headers: { Origin: gateway.origin }
      })
      expect(sameOrigin.status).toBe(200)
      // No Origin header (native client) stays allowed.
      const native = await fetch(`${gateway.origin}/health`)
      expect(native.status).toBe(200)
      // Foreign origin is refused even though Host and path are valid.
      const foreign = await fetch(`${gateway.origin}/health`, {
        headers: { Origin: 'https://attacker.example' }
      })
      expect(foreign.status).toBe(403)
      // Opaque "null" origin counts as a mismatch.
      const opaque = await fetch(`${gateway.origin}/health`, {
        headers: { Origin: 'null' }
      })
      expect(opaque.status).toBe(403)
      const audit = readFileSync(auditPath, 'utf8')
      expect(audit).toContain('origin_forbidden')
      expect(audit).toContain('attacker.example')
    } finally {
      await gateway.close()
    }
  })
})

describe('RemoteGateway audit redaction', () => {
  it('never writes goal.submit prompt text into the audit log (accepted and rejected paths)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vertragus-audit-redact-test-'))
    directories.push(directory)
    const auditPath = join(directory, 'audit.jsonl')
    const auth = new DeviceAuth(new MemoryStore())
    const gateway = await startRemoteGateway({
      auth,
      readModel: new RemoteReadModel(new EventEmitter()),
      audit: new RemoteAuditLog(auditPath),
      commands: commandRouter()
    })
    const paired = auth.pair(auth.startPairing(
      ['read', 'steer'], undefined, { id: 'owner', displayName: 'Owner' },
      [{ profileId: 'p', sessionIds: ['s'], allowGoalSubmit: true }]
    ).code, 'Phone')!
    const secret = 'streng geheimes Remote-Ziel mit personenbezogenen Daten'
    const post = (body: unknown): Promise<Response> => fetch(`${gateway.origin}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${paired.token}` },
      body: JSON.stringify(body)
    })
    try {
      const accepted = await post({
        id: 'goal.submit', args: { profileId: 'p', text: secret }, requestId: 'r-1'
      })
      expect(accepted.status).toBe(200)
      // Schema-rejected envelope: the error audit path must be redacted too.
      const rejected = await post({
        id: 'goal.submit', args: { profileId: 'p', text: secret, bogus: true }, requestId: 'r-2'
      })
      expect(rejected.status).toBe(400)
      const audit = readFileSync(auditPath, 'utf8')
      expect(audit).toContain('goal.submit')
      expect(audit).toContain('"textLength":' + String(secret.length))
      expect(audit).toContain('textSha256Prefix')
      expect(audit).not.toContain('geheimes')
      expect(audit).not.toContain(secret)
    } finally {
      await gateway.close()
    }
  })
})

describe('RemoteGateway pairing rate limit', () => {
  it('returns 429 once the pairing rate limit is exhausted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vertragus-pair-rl-test-'))
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
