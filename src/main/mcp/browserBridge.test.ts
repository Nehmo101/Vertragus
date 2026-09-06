import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

it('claims tabs synchronously across concurrent workers and releases them explicitly', async () => {
  const bridge = new BrowserBridge()
  const call = vi.spyOn(bridge, 'call').mockResolvedValue({ nodes: [] })
  try {
    const first = bridge.callOwned('alice', 'snapshot', { tabId: 7 })
    await expect(bridge.callOwned('bob', 'snapshot', { tabId: 7 })).rejects.toThrow('owned_by_another_task')
    await first
    await bridge.callOwned('alice', 'press', { key: 'Enter' })
    expect(call).toHaveBeenLastCalledWith('press', { key: 'Enter', tabId: 7 })
    bridge.releaseOwner('alice')
    await expect(bridge.callOwned('bob', 'snapshot', { tabId: 7 })).resolves.toEqual({ nodes: [] })
    await expect(bridge.callOwned('carol', 'snapshot')).rejects.toThrow('explicit tabId')
  } finally { bridge.close() }
})

it('a late navigate reply cannot reclaim a tab after its workspace closes', async () => {
  const bridge = new BrowserBridge()
  let finish!: (result: unknown) => void
  vi.spyOn(bridge, 'call').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const pending = bridge.callOwned('workspace:alice', 'navigate', { url: 'https://example.test' })
  bridge.releaseWorkspace('workspace')
  finish({ id: 4 })
  await expect(pending).rejects.toThrow('browser_task_released')
  bridge.close()
})

async function connectExtension(port: number, token: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${BROWSER_PATH}?token=${token}`)
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  return socket
}

it('ignores foreign and malformed replies and propagates extension errors over a real socket', async () => {
  const { bridge, port, close } = await listen()
  const primary = await connectExtension(port, bridge.status().token)
  const foreign = await connectExtension(port, bridge.status().token)
  try {
    const command = new Promise<{ id: string }>((resolve) => primary.once('message', (raw) => resolve(JSON.parse(String(raw)))))
    const pending = bridge.call('snapshot', { tabId: 1 })
    const rejected = expect(pending).rejects.toThrow('stale reference')
    const { id } = await command
    foreign.send(JSON.stringify({ id, type: 'result', result: { stolen: true } }))
    for (const frame of ['bad json', 'null', '7', '{}', '{"type":"hello"}', '{"type":"result","id":3}', '{"type":"result","id":"unknown"}']) primary.send(frame)
    primary.send(JSON.stringify({ id, type: 'result', ok: false, error: 'stale reference' }))
    await rejected
    const nextCommand = new Promise<{ id: string }>((resolve) => primary.once('message', (raw) => resolve(JSON.parse(String(raw)))))
    const next = bridge.call('click', { tabId: 1, ref: 'missing' })
    const fallback = expect(next).rejects.toThrow('browser_error')
    primary.send(JSON.stringify({ id: (await nextCommand).id, type: 'result', ok: false, error: 123 }))
    await fallback
  } finally { primary.close(); foreign.close(); await close() }
})

it('times out an unanswered command, and disconnecting its extension rejects pending work', async () => {
  const { bridge, port, close } = await listen()
  const primary = await connectExtension(port, bridge.status().token)
  const backup = await connectExtension(port, bridge.status().token)
  try {
    await expect(bridge.call('snapshot', { tabId: 1 }, 10)).rejects.toThrow('browser_timeout')
    const command = new Promise<void>((resolve) => primary.once('message', () => resolve()))
    const pending = bridge.call('snapshot', { tabId: 1 })
    const rejected = expect(pending).rejects.toThrow('browser_disconnected')
    await command
    primary.close()
    await rejected
    expect(bridge.status().connected).toBe(true)
  } finally { primary.close(); backup.close(); await close() }
})

it('rotation fails outstanding browser commands instead of accepting old extension replies', async () => {
  const { bridge, port, close } = await listen()
  const socket = await connectExtension(port, bridge.status().token)
  try {
    const pending = bridge.call('snapshot', { tabId: 1 })
    const rejected = expect(pending).rejects.toThrow('pairing token rotated')
    bridge.regenerateToken()
    await rejected
    expect(bridge.status().connected).toBe(false)
  } finally { socket.close(); await close() }
})

it('navigation claims its returned tab and browser errors cannot become successful snapshots', async () => {
  const bridge = new BrowserBridge()
  const call = vi.spyOn(bridge, 'call').mockResolvedValueOnce({ id: 9 }).mockResolvedValueOnce({ tabs: [] }).mockResolvedValueOnce({ error: 'unknown ref' })
  try {
    await bridge.callOwned('one:alice', 'navigate', { url: 'https://example.test' })
    await expect(bridge.callOwned('two:bob', 'click', { tabId: 9, ref: 'ref' })).rejects.toThrow('owned_by_another_task')
    await expect(bridge.callOwned('two:bob', 'tabs')).resolves.toEqual({ tabs: [] })
    await expect(bridge.callOwned('one:alice', 'snapshot')).rejects.toThrow('unknown ref')
    bridge.releaseWorkspace('two')
    await expect(bridge.callOwned('two:bob', 'snapshot', { tabId: 9 })).rejects.toThrow('owned_by_another_task')
    expect(call).toHaveBeenCalledTimes(3)
  } finally { bridge.close() }
})

it('a secondary extension disconnect cannot release primary tab ownership or its pending call', async () => {
  const { bridge, port, close } = await listen()
  const primary = await connectExtension(port, bridge.status().token)
  const secondary = await connectExtension(port, bridge.status().token)
  try {
    const command = new Promise<{ id: string }>((resolve) => primary.once('message', (raw) => resolve(JSON.parse(String(raw)))))
    const pending = bridge.callOwned('alice', 'snapshot', { tabId: 7 })
    const { id } = await command
    secondary.close()
    await new Promise<void>((resolve) => secondary.once('close', () => resolve()))
    await expect(bridge.callOwned('bob', 'snapshot', { tabId: 7 })).rejects.toThrow('owned_by_another_task')
    primary.send(JSON.stringify({ id, type: 'result', result: { nodes: [] } }))
    await expect(pending).resolves.toEqual({ nodes: [] })
  } finally { primary.close(); secondary.close(); await close() }
})
