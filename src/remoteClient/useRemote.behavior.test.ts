import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useRemote } from './useRemote'

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) } }
}
afterEach(() => vi.unstubAllGlobals())
it('migrates a legacy pairing token even with a saved session and retains only a device credential', async () => {
  const local = storage({ 'vertragus.remote.pairing': 'universal-secret', 'vertragus.remote.session': 'old-session' })
  const fetch = vi.fn<typeof globalThis.fetch>(async () => ({ ok: true, json: async () => ({ session: 'fresh-session', deviceCredential: 'device.private' }) }) as Response)
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('window', {
    localStorage: local, sessionStorage: storage(), navigator: { onLine: true },
    location: { hash: '', pathname: '/', search: '', protocol: 'http:', host: 'localhost' },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout, clearTimeout
  })
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('WebSocket', class {
    static OPEN = 1
    readyState = 0
    close() {}
  })
  let tree!: ReactTestRenderer
  function Probe() { useRemote(); return null }
  try {
    await act(async () => { tree = create(createElement(Probe)) })
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ pairingToken: 'universal-secret' })
    expect(local.getItem('vertragus.remote.pairing')).toBeNull()
    expect(local.getItem('vertragus.remote.device')).toBe('device.private')
    expect(local.getItem('vertragus.remote.session')).toBe('fresh-session')
  } finally { act(() => tree.unmount()) }
})
