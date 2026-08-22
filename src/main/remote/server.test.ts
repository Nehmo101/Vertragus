import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { isRequestAllowed, refreshesIdleTimer, startRemoteServer } from './server'
import type { RemoteGatewayHost } from './gateway'
import type { TerminalDirectory } from '@main/ipc'
import type { ServerMessage } from '@shared/remote/protocol'

describe('isRequestAllowed', () => {
  it('accepts the bind host and loopback, rejects a foreign Host (rebinding)', () => {
    expect(isRequestAllowed({ host: '100.64.10.20:9482' }, '100.64.10.20')).toBe(true)
    expect(isRequestAllowed({ host: 'localhost:9482' }, '100.64.10.20')).toBe(true)
    expect(isRequestAllowed({ host: 'evil.example:9482' }, '100.64.10.20')).toBe(false)
    expect(isRequestAllowed({ host: undefined }, '100.64.10.20')).toBe(false)
  })

  it('rejects a foreign Origin even with a valid Host', () => {
    expect(
      isRequestAllowed({ host: '100.64.10.20:9482', origin: 'https://evil.example' }, '100.64.10.20')
    ).toBe(false)
    expect(
      isRequestAllowed({ host: '100.64.10.20:9482', origin: 'http://100.64.10.20:9482' }, '100.64.10.20')
    ).toBe(true)
  })

  it('in 0.0.0.0 mode accepts bare IP hosts but still rejects DNS names (rebinding defence stays on)', () => {
    // A LAN client reaching the app by IP is fine.
    expect(isRequestAllowed({ host: '192.168.1.5:9482' }, '0.0.0.0')).toBe(true)
    expect(isRequestAllowed({ host: '[fd7a:115c::1]:9482' }, '0.0.0.0')).toBe(true)
    // A rebinding attack needs a hostname it controls — rejected even in 0.0.0.0.
    expect(isRequestAllowed({ host: 'evil.example:9482' }, '0.0.0.0')).toBe(false)
    // And a foreign Origin is still rejected.
    expect(
      isRequestAllowed({ host: '192.168.1.5:9482', origin: 'http://evil.example' }, '0.0.0.0')
    ).toBe(false)
  })
})

describe('refreshesIdleTimer', () => {
  it('counts every frame a user causes as activity', () => {
    for (const type of ['auth', 'attach', 'detach', 'input', 'resize', 'command'] as const) {
      expect(refreshesIdleTimer(type)).toBe(true)
    }
  })

  it('does not count the liveness probe', () => {
    // `refresh` is the client's probe as well as its reload — it fires on a
    // timer, forever, on any tab left open. Treating it as activity means
    // SESSION_IDLE_MS can never elapse for a connected client.
    expect(refreshesIdleTimer('refresh')).toBe(false)
  })
})

/**
 * The two behaviours the unit tests above cannot reach: that the idle expiry
 * actually elapses under a probing client, and that a revoked device is told
 * it was revoked rather than left to re-pair itself.
 */
describe('startRemoteServer — sessions over a live socket', () => {
  interface Harness {
    handle: Awaited<ReturnType<typeof startRemoteServer>>
    advance(ms: number): void
  }

  const gateway: RemoteGatewayHost = {
    listWorkspaces: () => [],
    listProfiles: () => [],
    startWorkspace: () => undefined,
    stopWorkspace: () => undefined,
    answerQuestion: () => undefined,
    userMessage: () => undefined
  }

  const terminals = (): TerminalDirectory => ({
    list: () => [],
    get: () => undefined,
    attach: () => undefined,
    write: () => false,
    resize: () => false
  })

  const IDLE_MS = 10_000

  async function withServer(run: (harness: Harness) => Promise<void>): Promise<void> {
    let clock = 1_000
    const handle = await startRemoteServer({
      host: '127.0.0.1',
      port: 0,
      pairingToken: () => 'pair-secret',
      gateway,
      terminals,
      onWorkspaceChange: () => () => undefined,
      locale: () => 'de',
      theme: () => 'dark',
      staticRoot: '/nonexistent-static-root',
      authDeps: { now: () => clock, idleMs: IDLE_MS }
    })
    try {
      await run({ handle, advance: (ms) => (clock += ms) })
    } finally {
      await handle.close()
    }
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

  /** The next frame this socket receives, parsed. */
  function nextMessage(socket: WebSocket): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      socket.once('message', (raw) => resolve(JSON.parse(raw.toString()) as ServerMessage))
      socket.once('close', () => reject(new Error('closed before a frame arrived')))
    })
  }

  async function connect(port: number, session: string): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise((resolve) => socket.once('open', resolve))
    const hello = nextMessage(socket)
    socket.send(JSON.stringify({ type: 'auth', session }))
    expect((await hello).type).toBe('hello')
    return socket
  }

  it('lets a session age out even while the client keeps probing', async () => {
    await withServer(async ({ handle, advance }) => {
      const socket = await connect(handle.port, await pair(handle.port))
      try {
        // A probing client, well inside the idle window.
        advance(IDLE_MS - 1)
        const answer = nextMessage(socket)
        socket.send(JSON.stringify({ type: 'refresh' }))
        expect((await answer).type).toBe('workspaces')

        // Past it. Had the probe touched the session, this would still be a
        // `workspaces` push and the expiry would be unreachable forever.
        advance(2)
        const verdict = nextMessage(socket)
        socket.send(JSON.stringify({ type: 'refresh' }))
        expect(await verdict).toEqual({ type: 'session_revoked', reason: 'expired' })
      } finally {
        socket.close()
      }
    })
  })

  it('keeps a session alive on traffic a user actually caused', async () => {
    await withServer(async ({ handle, advance }) => {
      const socket = await connect(handle.port, await pair(handle.port))
      const seen: ServerMessage[] = []
      socket.on('message', (raw) => seen.push(JSON.parse(raw.toString()) as ServerMessage))
      try {
        // Three times the idle window, crossed one user action at a time: an
        // attach touches the session, so the client never ages out.
        for (let i = 0; i < 3; i++) {
          advance(IDLE_MS - 1)
          socket.send(JSON.stringify({ type: 'attach', agentId: 'a1' }))
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        expect(seen.some((message) => message.type === 'session_revoked')).toBe(false)
        expect(socket.readyState).toBe(WebSocket.OPEN)
      } finally {
        socket.close()
      }
    })
  })

  it('tells a revoked device that it was revoked, not that it expired', async () => {
    await withServer(async ({ handle }) => {
      const socket = await connect(handle.port, await pair(handle.port))
      try {
        const [client] = handle.clients()
        const notice = nextMessage(socket)
        expect(handle.revoke(client!.id)).toBe(true)
        // The reason is the whole point: on `expired` the client re-pairs from
        // its stored pairing token, which would undo the revoke in a second.
        expect(await notice).toEqual({ type: 'session_revoked', reason: 'revoked' })
      } finally {
        socket.close()
      }
    })
  })
})
