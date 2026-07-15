import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { parseTunnelUrl, TunnelManager, type TunnelProcess, type TunnelSpawner } from './tunnelManager'

class FakeProcess extends EventEmitter implements TunnelProcess {
  stderr = new PassThrough()
  kill = vi.fn(() => true)
}

describe('TunnelManager', () => {
  it('parses named and quick Cloudflare HTTPS URLs but rejects localhost', () => {
    expect(parseTunnelUrl('INF https://mission.example.com connected')).toBe('https://mission.example.com')
    expect(parseTunnelUrl('Visit https://random.trycloudflare.com now')).toBe('https://random.trycloudflare.com')
    expect(parseTunnelUrl('https://localhost:1234')).toBeUndefined()
  })

  it('launches without placing the token in argv and kills on stop', async () => {
    const process = new FakeProcess()
    const spawn = vi.fn<TunnelSpawner>(() => process)
    const manager = new TunnelManager(spawn, async (_command, args) => ({ file: 'cloudflared', args }))
    await manager.start({
      origin: 'http://127.0.0.1:1234', hostname: 'mission.example.com', tunnelToken: 'super-secret'
    })
    process.emit('spawn')
    expect(manager.status()).toMatchObject({ state: 'online', publicUrl: 'https://mission.example.com' })
    expect(spawn.mock.calls[0]?.[1].join(' ')).not.toContain('super-secret')
    expect(spawn.mock.calls[0]?.[2].env.TUNNEL_TOKEN).toBe('super-secret')
    await manager.stop()
    expect(process.kill).toHaveBeenCalled()
    expect(manager.status().state).toBe('disabled')
  })

  it('accepts only a parsed trycloudflare URL before marking a quick tunnel online', async () => {
    const process = new FakeProcess()
    const manager = new TunnelManager(
      vi.fn<TunnelSpawner>(() => process),
      async (_command, args) => ({ file: 'cloudflared', args })
    )
    await manager.start({ origin: 'http://127.0.0.1:1234', mode: 'quick' })
    process.emit('spawn')
    expect(manager.status().state).toBe('starting')
    process.stderr.write('INF quick Tunnel https://mobile-test.trycloudflare.com ready')
    expect(manager.status()).toMatchObject({
      state: 'online', mode: 'quick', publicUrl: 'https://mobile-test.trycloudflare.com'
    })
    await manager.stop()
  })

  it('reconnects with bounded backoff after an unexpected exit', async () => {
    vi.useFakeTimers()
    try {
      const processes = [new FakeProcess(), new FakeProcess()]
      const spawn = vi.fn<TunnelSpawner>(() => processes.shift()!)
      const manager = new TunnelManager(
        spawn,
        async (_command, args) => ({ file: 'cloudflared', args }),
        () => 0.5
      )
      await manager.start({
        origin: 'http://127.0.0.1:1234', hostname: 'mission.example.com', tunnelToken: 'secret'
      })
      const first = spawn.mock.results[0]!.value as FakeProcess
      first.emit('exit', 1, null)
      expect(manager.status()).toMatchObject({ state: 'degraded', reconnectAttempt: 1 })
      await vi.advanceTimersByTimeAsync(999)
      expect(spawn).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(spawn).toHaveBeenCalledTimes(2)
      await manager.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
