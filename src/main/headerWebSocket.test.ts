import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { HeaderWebSocket } from './headerWebSocket'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function acceptKey(key: string): string {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64')
}

function completeUpgrade(req: IncomingMessage, socket: Socket): void {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string') {
    socket.destroy()
    return
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
      '\r\n'
  )
}

function listen(): Promise<{ server: Server; url: string }> {
  const server = createServer()
  server.on('connection', (socket) => {
    socket.on('error', () => undefined)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({ server, url: `ws://127.0.0.1:${addr.port}/` })
    })
  })
}

function waitReadyState(ws: HeaderWebSocket, state: number, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (ws.readyState === state) {
        resolve()
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for readyState ${state}, was ${ws.readyState}`))
        return
      }
      setTimeout(tick, 5)
    }
    tick()
  })
}

function errorMessage(event: unknown): string {
  if (event && typeof event === 'object' && 'message' in event) {
    const message = (event as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return ''
}

describe('HeaderWebSocket', () => {
  const servers: Server[] = []

  afterEach(() => {
    for (const server of servers) {
      server.closeAllConnections()
      server.close()
    }
    servers.length = 0
  })

  it('opens on a 101 upgrade', async () => {
    const { server, url } = await listen()
    servers.push(server)
    server.on('upgrade', (req, socket) => {
      socket.on('error', () => undefined)
      completeUpgrade(req, socket)
    })

    const ws = new HeaderWebSocket(url)
    await waitReadyState(ws, 1)
    ws.close()
    await waitReadyState(ws, 3)
  })

  it('fails immediately on a non-upgrade HTTP response', async () => {
    const { server, url } = await listen()
    servers.push(server)
    server.on('upgrade', (_req, socket) => {
      socket.on('error', () => undefined)
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
      )
      socket.end()
    })

    const ws = new HeaderWebSocket(url)
    const errors: string[] = []
    ws.onerror = (event) => {
      errors.push(errorMessage(event))
    }
    const started = Date.now()
    await waitReadyState(ws, 3)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(errors.some((message) => message.includes('HTTP 401'))).toBe(true)
  })

  it('aborts an in-flight handshake on close and ignores a late upgrade', async () => {
    const { server, url } = await listen()
    servers.push(server)
    let pending: { req: IncomingMessage; socket: Socket } | undefined
    server.on('upgrade', (req, socket) => {
      socket.on('error', () => undefined)
      pending = { req, socket }
    })

    const ws = new HeaderWebSocket(url)
    const opened: unknown[] = []
    ws.onopen = (event) => {
      opened.push(event ?? {})
    }

    const held = await new Promise<{ req: IncomingMessage; socket: Socket }>((resolve, reject) => {
      const started = Date.now()
      const tick = (): void => {
        if (pending) {
          resolve(pending)
          return
        }
        if (Date.now() - started > 2_000) {
          reject(new Error('server never saw the upgrade request'))
          return
        }
        setTimeout(tick, 5)
      }
      tick()
    })

    ws.close()
    expect(ws.readyState).toBe(3)

    try {
      completeUpgrade(held.req, held.socket)
    } catch {
      /* abort may already have destroyed the socket */
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(opened).toEqual([])
    expect(ws.readyState).toBe(3)
  })
})
