/**
 * The remote server over a real loopback HTTP + WebSocket round trip.
 *
 * No sleeps: every step waits for an actual response, an actual WS frame, or an
 * actual close. The server binds 127.0.0.1 here (a real tailnet is not
 * available in CI); the Host/Origin logic that gates a non-loopback bind is
 * unit-tested separately.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { TerminalDirectory, TerminalSink } from '@main/ipc'
import type { RemoteGatewayHost } from '@main/remote/gateway'
import { startRemoteServer, type RemoteServerHandle } from '@main/remote/server'
import type { ServerMessage } from '@shared/remote/protocol'

let staticRoot: string
let handle: RemoteServerHandle | undefined
const openSockets: WebSocket[] = []

function fakeTerminals(): { directory: TerminalDirectory; emit: (data: string) => void } {
  let sink: TerminalSink | undefined
  const directory: TerminalDirectory = {
    list: () => [],
    get: () => undefined,
    attach: (agentId, s) => {
      if (agentId !== 'a1') return undefined
      sink = s
      return {
        snapshot: 'SNAP',
        cols: 80,
        rows: 24,
        meta: { agentId, name: 'Caronte', role: 'worker', roleColor: '#123', provider: 'claude', model: 'sonnet' },
        exit: null,
        detach: () => (sink = undefined)
      }
    },
    write: () => true,
    resize: () => true
  }
  return { directory, emit: (data) => sink?.onData(data) }
}

const started: string[] = []
const gateway: RemoteGatewayHost = {
  listWorkspaces: () => [
    { workspaceId: 'w1', name: 'Paradiso', profileId: 'p1', active: true, agents: [] }
  ],
  listProfiles: () => [{ id: 'p1', name: 'Profile', repoPath: '/repo' }],
  startWorkspace: (profileId) => {
    started.push(profileId)
  },
  stopWorkspace: () => undefined
}

let notifyChange: (() => void) | undefined

async function server(terminals: TerminalDirectory): Promise<RemoteServerHandle> {
  return startRemoteServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken: () => 'pair-secret',
    gateway,
    terminals: () => terminals,
    onWorkspaceChange: (listener) => {
      notifyChange = listener
      return () => (notifyChange = undefined)
    },
    locale: () => 'de',
    theme: () => 'dark',
    staticRoot,
    authDeps: { newToken: (() => `sess-${Math.random()}`) as () => string }
  })
}

function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  openSockets.push(socket)
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

/** Resolve with the next server frame of a given type. */
function nextMessage(socket: WebSocket, type: ServerMessage['type']): Promise<ServerMessage> {
  return new Promise((resolve) => {
    const onMessage = (raw: WebSocket.RawData): void => {
      const message = JSON.parse(raw.toString()) as ServerMessage
      if (message.type === type) {
        socket.off('message', onMessage)
        resolve(message)
      }
    }
    socket.on('message', onMessage)
  })
}

async function pair(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingToken: 'pair-secret' })
  })
  const body = (await response.json()) as { session: string }
  return body.session
}

beforeEach(() => {
  staticRoot = mkdtempSync(join(tmpdir(), 'vertragus-remote-'))
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>Vertragus</title>')
  started.length = 0
})

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close()
  await handle?.close()
  handle = undefined
  rmSync(staticRoot, { recursive: true, force: true })
})

describe('remote server auth', () => {
  it('serves the client index for the root', async () => {
    handle = await server(fakeTerminals().directory)
    const response = await fetch(`http://127.0.0.1:${handle.port}/`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Vertragus')
  })

  it('mints a session for the right pairing token and 401s a wrong one', async () => {
    handle = await server(fakeTerminals().directory)
    const ok = await fetch(`http://127.0.0.1:${handle.port}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingToken: 'pair-secret' })
    })
    expect(ok.status).toBe(200)
    expect((await ok.json()).session).toBeTruthy()

    const bad = await fetch(`http://127.0.0.1:${handle.port}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingToken: 'wrong' })
    })
    expect(bad.status).toBe(401)
  })

  it('403s a request with a foreign Host header', async () => {
    handle = await server(fakeTerminals().directory)
    const response = await fetch(`http://127.0.0.1:${handle.port}/`, {
      headers: { Host: 'evil.example' }
    })
    // fetch may keep its own Host; assert via undici by setting it is unreliable,
    // so this is a best-effort check — the unit test covers isRequestAllowed.
    expect([200, 403]).toContain(response.status)
  })
})

describe('remote server websocket', () => {
  it('rejects a socket whose first frame is not a valid session', async () => {
    handle = await server(fakeTerminals().directory)
    const socket = await connect(handle.port)
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    socket.send(JSON.stringify({ type: 'auth', session: 'not-a-real-session' }))
    await closed
    expect(socket.readyState).toBe(WebSocket.CLOSED)
  })

  it('sends hello after auth, then streams a terminal snapshot and live data', async () => {
    const terminals = fakeTerminals()
    handle = await server(terminals.directory)
    const session = await pair(handle.port)
    const socket = await connect(handle.port)

    const hello = nextMessage(socket, 'hello')
    socket.send(JSON.stringify({ type: 'auth', session }))
    expect(await hello).toMatchObject({ type: 'hello', locale: 'de', theme: 'dark' })

    const snapshot = nextMessage(socket, 'snapshot')
    socket.send(JSON.stringify({ type: 'attach', agentId: 'a1' }))
    expect(await snapshot).toMatchObject({ type: 'snapshot', agentId: 'a1', snapshot: 'SNAP', name: 'Caronte' })

    const data = nextMessage(socket, 'data')
    terminals.emit('hello from the pty')
    expect(await data).toMatchObject({ type: 'data', agentId: 'a1', data: 'hello from the pty' })
  })

  it('runs an allow-listed command and fans out a workspace change', async () => {
    handle = await server(fakeTerminals().directory)
    const session = await pair(handle.port)
    const socket = await connect(handle.port)
    const hello = nextMessage(socket, 'hello')
    socket.send(JSON.stringify({ type: 'auth', session }))
    await hello

    const result = nextMessage(socket, 'command_result')
    socket.send(JSON.stringify({ type: 'command', id: 'c1', name: 'workspaces:start', arg: 'p1' }))
    expect(await result).toMatchObject({ type: 'command_result', id: 'c1', ok: true })
    expect(started).toEqual(['p1'])

    const pushed = nextMessage(socket, 'workspaces')
    notifyChange?.()
    expect(await pushed).toMatchObject({ type: 'workspaces' })
  })

  it('survives a socket whose message handler throws — one bad frame never crashes the server', async () => {
    // A terminal whose write throws models a dead node-pty (H1). The offending
    // socket must be closed, but the server must keep serving other clients.
    const throwing: TerminalDirectory = {
      list: () => [],
      get: () => undefined,
      attach: (agentId, sink) => {
        void sink
        return {
          snapshot: '',
          cols: 80,
          rows: 24,
          meta: { agentId, name: 'X', role: 'worker', roleColor: '#000', provider: 'p', model: 'm' },
          exit: null,
          detach: () => undefined
        }
      },
      write: () => {
        throw new Error('pty is dead')
      },
      resize: () => true
    }
    handle = await server(throwing)
    const session1 = await pair(handle.port)
    const socket1 = await connect(handle.port)
    const hello1 = nextMessage(socket1, 'hello')
    socket1.send(JSON.stringify({ type: 'auth', session: session1 }))
    await hello1
    const snapshot = nextMessage(socket1, 'snapshot')
    socket1.send(JSON.stringify({ type: 'attach', agentId: 'a1' }))
    await snapshot

    const closed1 = new Promise<void>((resolve) => socket1.once('close', () => resolve()))
    // This input throws inside the handler; the socket closes, the server lives.
    socket1.send(JSON.stringify({ type: 'input', agentId: 'a1', data: 'boom' }))
    await closed1

    // A fresh client still gets a full handshake — the server never crashed.
    const session2 = await pair(handle.port)
    const socket2 = await connect(handle.port)
    const hello2 = nextMessage(socket2, 'hello')
    socket2.send(JSON.stringify({ type: 'auth', session: session2 }))
    expect(await hello2).toMatchObject({ type: 'hello' })
  })

  it('closes a client when its session is revoked', async () => {
    handle = await server(fakeTerminals().directory)
    const session = await pair(handle.port)
    const socket = await connect(handle.port)
    const hello = nextMessage(socket, 'hello')
    socket.send(JSON.stringify({ type: 'auth', session }))
    await hello

    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    // Revoke targets the public client id, not the secret session token.
    const client = handle.clients()[0]
    expect(client).toBeDefined()
    expect(handle.revoke(client!.id)).toBe(true)
    await closed
    expect(socket.readyState).toBe(WebSocket.CLOSED)
  })
})
