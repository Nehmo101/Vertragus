import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { BROWSER_PATH } from '@shared/browserExtension'
import { BrowserBridge } from './browserBridge'
import { MCP_BIND_HOST } from './server'

async function listen(): Promise<{
  bridge: BrowserBridge
  port: number
  close: () => Promise<void>
}> {
  const bridge = new BrowserBridge({ token: 'a'.repeat(32) })
  const http = createServer((_req, res) => {
    res.writeHead(404).end()
  })
  http.on('upgrade', (req, socket, head) => {
    if (!bridge.handleUpgrade(req, socket, head, MCP_BIND_HOST)) socket.destroy()
  })
  const port = await new Promise<number>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, MCP_BIND_HOST, () => {
      const address = http.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  bridge.port = port
  return {
    bridge,
    port,
    close: () =>
      new Promise((resolve) => {
        bridge.close()
        http.close(() => resolve())
      })
  }
}

describe('BrowserBridge', () => {
  let shutdown: (() => Promise<void>) | undefined

  afterEach(async () => {
    await shutdown?.()
    shutdown = undefined
  })

  it('refuses a call while disconnected with browser_disconnected', async () => {
    const { bridge, close } = await listen()
    shutdown = close
    await expect(bridge.call('tabs')).rejects.toMatchObject({ name: 'browser_disconnected' })
    expect(bridge.status().connected).toBe(false)
  })

  it('rejects a bad token and a non-loopback origin on upgrade', async () => {
    const { port, close } = await listen()
    shutdown = close
    const badToken = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${BROWSER_PATH}?token=wrong`)
      ws.on('error', () => resolve(1))
      ws.on('open', () => {
        ws.close()
        resolve(0)
      })
    })
    expect(badToken).toBe(1)
  })

  it('forwards a command to the extension and returns the result', async () => {
    const { bridge, port, close } = await listen()
    shutdown = close
    const token = bridge.status().token
    const ws = new WebSocket(`ws://127.0.0.1:${port}${BROWSER_PATH}?token=${token}`)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { id: string; type: string; command: string }
      if (message.type !== 'command') return
      ws.send(JSON.stringify({ id: message.id, type: 'result', ok: true, result: { tabs: [{ id: 1 }] } }))
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(bridge.status().connected).toBe(true)
    await expect(bridge.call('tabs')).resolves.toEqual({ tabs: [{ id: 1 }] })
    ws.close()
    await close()
    shutdown = undefined
  })

  it('rejects an unknown command without talking to the client', async () => {
    const { bridge, close } = await listen()
    shutdown = close
    await expect(bridge.call('eval')).rejects.toThrow(/unknown browser command/)
  })

  it('rotating the token disconnects clients', async () => {
    const { bridge, close } = await listen()
    shutdown = close
    const previous = bridge.status().token
    const next = bridge.regenerateToken()
    expect(next).not.toBe(previous)
    expect(bridge.status().token).toBe(next)
    expect(bridge.status().connected).toBe(false)
  })
})
