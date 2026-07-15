import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteAuditLog } from './auditLog'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('RemoteAuditLog', () => {
  it('redacts credentials while preserving actor and action', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-remote-audit-'))
    dirs.push(dir)
    const path = join(dir, 'audit.jsonl')
    new RemoteAuditLog(path).record({
      kind: 'command', outcome: 'rejected', deviceId: 'device-7', action: 'goal.submit',
      detail: {
        authorization: 'Bearer abc.def-secret',
        text: 'keys sk-abcdefghijklmnop and ghp_abcdefghijklmnop'
      }
    })
    const raw = readFileSync(path, 'utf8')
    expect(raw).toContain('device-7')
    expect(raw).toContain('goal.submit')
    expect(raw).not.toContain('abc.def-secret')
    expect(raw).not.toContain('sk-abcdefghijklmnop')
    expect(raw).not.toContain('ghp_abcdefghijklmnop')
  })
})

