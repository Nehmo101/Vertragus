import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createRemoteDeviceFile } from './deviceStore'
import { RemoteAuthStore } from './auth'

it('persists hashed credentials and revocation across actual file reloads', () => {
  const root = mkdtempSync(join(tmpdir(), 'vertragus-devices-'))
  const path = join(root, 'devices.json')
  try {
    const deps = () => ({ pairingToken: () => 'pair', deviceStore: createRemoteDeviceFile(path) })
    const first = new RemoteAuthStore(deps())
    const paired = first.authenticate('pair', 'phone')
    if (!paired.ok) throw new Error('pair failed')
    expect(readdirSync(root)).toEqual(['devices.json'])
    const before = readFileSync(path, 'utf8')
    const circular: unknown[] = []
    circular.push(circular)
    expect(() => createRemoteDeviceFile(path).write(circular as import('./deviceStore').RemoteDevice[])).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(before)
    const second = new RemoteAuthStore(deps())
    expect(second.authenticate(paired.deviceCredential!, 'phone', true).ok).toBe(true)
    second.revoke(second.pairedDevices()[0].id)
    expect(new RemoteAuthStore(deps()).authenticate(paired.deviceCredential!, 'phone', true).ok).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('fails closed on corrupt device files while recovering independently valid device rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'vertragus-devices-corrupt-'))
  const path = join(root, 'devices.json')
  const store = createRemoteDeviceFile(path)
  const valid = { id: 'phone', credentialHash: 'hash', pairingHash: 'pair-hash', remoteAddress: '127.0.0.1', createdAt: 1, lastSeenAt: 2 }
  try {
    writeFileSync(path, '{broken')
    expect(store.read()).toEqual([])
    writeFileSync(path, '{"devices":[]}')
    expect(store.read()).toEqual([])
    const invalid = [null, {}, { ...valid, id: 7 }, { ...valid, credentialHash: 7 }, { ...valid, pairingHash: 7 }, { ...valid, remoteAddress: 7 }, { ...valid, createdAt: 'yesterday' }, { ...valid, lastSeenAt: null }]
    writeFileSync(path, JSON.stringify([...invalid, valid]))
    expect(store.read()).toEqual([valid])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
