import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveLaunch: vi.fn(),
  spawn: vi.fn(),
  runOllamaChat: vi.fn()
}))

vi.mock('@main/agents/resolveCommand', () => ({ resolveLaunch: mocks.resolveLaunch }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: mocks.spawn }
})
vi.mock('@main/agents/ollamaHeadless', () => ({ runOllamaChat: mocks.runOllamaChat }))

import {
  classifyFatalProviderStderr,
  runHeadless,
  type HeadlessLifecycleEvent
} from './headless'

const opts = { workingDir: '.', model: 'test', yolo: false }

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  Object.defineProperties(child, {
    pid: { value: 42 },
    stdout: { value: new PassThrough() },
    stderr: { value: new PassThrough() },
    kill: { value: vi.fn() }
  })
  return child
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('fatal provider stderr classification', () => {
  it('recognizes revoked authentication and Windows sandbox bootstrap failures', () => {
    expect(classifyFatalProviderStderr('codex', '401 token_revoked: invalidated OAuth token')).toMatchObject({
      kind: 'provider-auth'
    })
    expect(
      classifyFatalProviderStderr(
        'codex',
        'failed to prepare windows sandbox wrapper: CreateRestrictedToken failed: 87'
      )
    ).toMatchObject({ kind: 'sandbox' })
    expect(classifyFatalProviderStderr('codex', 'ordinary diagnostic output')).toBeUndefined()
  })
})

describe('runHeadless lifecycle', () => {
  it('resolves a command-resolution rejection as a failed result', async () => {
    mocks.resolveLaunch.mockRejectedValueOnce(new Error('CLI fehlt'))

    const result = await runHeadless('claude', 'task', opts, vi.fn()).done

    expect(result).toMatchObject({ status: 'failed', isError: true, result: 'CLI fehlt' })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('does not spawn when cancelled before command resolution completes', async () => {
    const launch = deferred<{ file: string; args: string[] }>()
    mocks.resolveLaunch.mockReturnValueOnce(launch.promise)
    const handle = runHeadless('claude', 'task', opts, vi.fn())

    handle.kill()
    await expect(handle.done).resolves.toMatchObject({ status: 'cancelled', isError: true })
    launch.resolve({ file: 'claude', args: [] })
    await Promise.resolve()

    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('does not automatically time-limit command resolution', async () => {
    vi.useFakeTimers()
    const launch = deferred<{ file: string; args: string[] }>()
    mocks.resolveLaunch.mockReturnValueOnce(launch.promise)
    const handle = runHeadless('claude', 'task', opts, vi.fn())
    let settled = false
    void handle.done.then(() => { settled = true })

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)

    expect(settled).toBe(false)
    handle.kill()
    await expect(handle.done).resolves.toMatchObject({ status: 'cancelled', isError: true })
  })
  it('returns a succeeded status for a clean exit', async () => {
    const child = fakeChild()
    mocks.resolveLaunch.mockResolvedValueOnce({ file: 'claude', args: [] })
    mocks.spawn.mockReturnValueOnce(child)
    const handle = runHeadless('claude', 'task', opts, vi.fn())
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())

    child.emit('close', 0)

    await expect(handle.done).resolves.toMatchObject({ status: 'succeeded', isError: false })
  })

  it('keeps exit zero plus an explicit success result successful after an earlier provider error', async () => {
    const child = fakeChild()
    mocks.resolveLaunch.mockResolvedValueOnce({ file: 'codex', args: [] })
    mocks.spawn.mockReturnValueOnce(child)
    const handle = runHeadless('codex', 'task', opts, vi.fn())
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())

    child.stdout?.emit('data', Buffer.from(`${JSON.stringify({
      type: 'turn.failed',
      error: { message: 'earlier provider error' }
    })}\n${JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: 'Geänderte Dateien und grüne Gates geprüft.\nERGEBNIS: ERFOLG'
      }
    })}\n`))
    child.emit('close', 0)

    await expect(handle.done).resolves.toMatchObject({
      status: 'succeeded',
      isError: false,
      exitCode: 0,
      result: expect.stringContaining('ERGEBNIS: ERFOLG')
    })
  })

  it('streams accumulating usage snapshots for live telemetry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T00:00:00Z'))
    const child = fakeChild()
    const events: HeadlessLifecycleEvent[] = []
    mocks.resolveLaunch.mockResolvedValueOnce({ file: 'claude', args: [] })
    mocks.spawn.mockReturnValueOnce(child)

    const handle = runHeadless('claude', 'task', opts, vi.fn(), {
      heartbeatIntervalMs: 30_000,
      onEvent: (event) => events.push(event)
    })
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())

    child.stdout?.emit(
      'data',
      Buffer.from(`${JSON.stringify({
        type: 'result',
        result: 'fertig',
        is_error: false,
        total_cost_usd: 0.02,
        num_turns: 3,
        usage: { input_tokens: 12, output_tokens: 8 }
      })}\n`)
    )

    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      type: 'usage',
      costUsd: 0.02,
      tokensIn: 12,
      tokensOut: 8,
      steps: 3
    })

    child.emit('close', 0)
    await expect(handle.done).resolves.toMatchObject({
      status: 'succeeded',
      costUsd: 0.02,
      tokensIn: 12,
      tokensOut: 8,
      steps: 3
    })
  })

  it('fails a Codex run immediately when stderr reports a revoked token', async () => {
    const child = fakeChild()
    mocks.resolveLaunch.mockResolvedValueOnce({ file: 'codex', args: [] })
    mocks.spawn.mockReturnValueOnce(child)
    if (process.platform === 'win32') mocks.spawn.mockReturnValueOnce(fakeChild())
    const handle = runHeadless('codex', 'task', opts, vi.fn())
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled())

    child.stderr?.emit('data', Buffer.from('401 token_revoked: invalidated OAuth token'))
    child.emit('error', new Error('terminated after fatal stderr'))

    await expect(handle.done).resolves.toMatchObject({
      status: 'failed',
      isError: true,
      failureKind: 'provider-auth',
      result: expect.stringContaining('Provider-Login erneuern')
    })
  })

  it('stalls only on missing meaningful progress; stderr noise does not keep it alive', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T00:00:00Z'))
    const child = fakeChild()
    mocks.resolveLaunch.mockResolvedValueOnce({ file: 'codex', args: [] })
    mocks.spawn.mockReturnValueOnce(child)
    if (process.platform === 'win32') mocks.spawn.mockReturnValueOnce(fakeChild())
    const handle = runHeadless('codex', 'task', opts, vi.fn(), {
      stallTimeoutMs: 60_000,
      onEvent: vi.fn()
    })
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled())

    await vi.advanceTimersByTimeAsync(30_000)
    child.stderr?.emit('data', Buffer.from('diagnostic heartbeat only'))
    await vi.advanceTimersByTimeAsync(30_000)
    child.emit('close', 0)

    await expect(handle.done).resolves.toMatchObject({
      status: 'failed',
      failureKind: 'stalled',
      result: expect.stringContaining('ohne sinnvollen Provider-Fortschritt')
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders a Codex command once across item.started and item.completed JSONL events', async () => {
    const child = fakeChild()
    const output: string[] = []
    mocks.resolveLaunch.mockResolvedValueOnce({ file: 'codex', args: [] })
    mocks.spawn.mockReturnValueOnce(child)
    const handle = runHeadless('codex', 'task', opts, (chunk) => output.push(chunk))
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())

    const started = {
      type: 'item.started',
      item: { id: 'cmd-1', type: 'command_execution', command: 'rg --files' }
    }
    const completed = {
      type: 'item.completed',
      item: { id: 'cmd-1', type: 'command_execution', command: 'rg --files', status: 'completed', exit_code: 0 }
    }
    child.stdout?.emit('data', Buffer.from(`${JSON.stringify(started)}\n${JSON.stringify(completed)}\n`))
    child.emit('close', 0)

    await expect(handle.done).resolves.toMatchObject({ status: 'succeeded' })
    expect(output.join('').match(/\$ rg --files/g)).toHaveLength(1)
  })

  it('emits structured phases, progress, output, heartbeats, and a terminal event', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T00:00:00Z'))
    const child = fakeChild()
    const events: HeadlessLifecycleEvent[] = []
    mocks.resolveLaunch.mockResolvedValueOnce({ file: 'claude', args: [] })
    mocks.spawn.mockReturnValueOnce(child)

    const handle = runHeadless('claude', 'task', opts, vi.fn(), {
      heartbeatIntervalMs: 30_000,
      onEvent: (event) => events.push(event)
    })
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())

    child.stdout?.emit(
      'data',
      Buffer.from(`${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Arbeite' }] }
      })}\n`)
    )
    await vi.advanceTimersByTimeAsync(30_000)

    const heartbeat = events.find((event) => event.type === 'heartbeat')
    expect(heartbeat).toMatchObject({
      type: 'heartbeat',
      phase: 'running',
      elapsedMs: 30_000,
      pid: 42
    })
    expect(heartbeat?.type === 'heartbeat' ? heartbeat.idleMs : 0).toBeGreaterThanOrEqual(29_000)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'started', provider: 'claude', phase: 'starting' }),
        expect.objectContaining({ type: 'phase', phase: 'resolving-command' }),
        expect.objectContaining({ type: 'phase', phase: 'starting-process' }),
        expect.objectContaining({ type: 'phase', phase: 'running' }),
        expect.objectContaining({ type: 'progress', providerEvent: 'assistant', pid: 42 }),
        expect.objectContaining({ type: 'output', source: 'stdout' })
      ])
    )

    child.emit('close', 0)
    await expect(handle.done).resolves.toMatchObject({ status: 'succeeded' })
    expect(events.at(-1)).toMatchObject({
      type: 'finished',
      phase: 'finished',
      status: 'succeeded'
    })

    expect(vi.getTimerCount()).toBe(0)
    const eventCount = events.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(events).toHaveLength(eventCount)
  })

  it('clamps heartbeat configuration to 30 seconds and clears it on early cancellation', async () => {
    vi.useFakeTimers()
    const launch = deferred<{ file: string; args: string[] }>()
    const events: HeadlessLifecycleEvent[] = []
    mocks.resolveLaunch.mockReturnValueOnce(launch.promise)
    const handle = runHeadless('claude', 'task', opts, vi.fn(), {
      heartbeatIntervalMs: 1,
      onEvent: (event) => events.push(event)
    })

    await vi.advanceTimersByTimeAsync(29_999)
    expect(events.filter((event) => event.type === 'heartbeat')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(events.filter((event) => event.type === 'heartbeat')).toHaveLength(1)

    handle.kill()
    await expect(handle.done).resolves.toMatchObject({ status: 'cancelled' })
    expect(events.at(-1)).toMatchObject({ type: 'finished', status: 'cancelled' })
    expect(vi.getTimerCount()).toBe(0)

    const eventCount = events.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(events).toHaveLength(eventCount)
  })

  it('cleans up lifecycle heartbeats when an Ollama adapter finishes', async () => {
    vi.useFakeTimers()
    const ollamaDone = deferred<{ result: string; isError: boolean }>()
    const events: HeadlessLifecycleEvent[] = []
    mocks.runOllamaChat.mockReturnValueOnce({
      pid: undefined,
      done: ollamaDone.promise,
      kill: vi.fn()
    })

    const handle = runHeadless('ollama', 'task', opts, vi.fn(), {
      heartbeatIntervalMs: 30_000,
      onEvent: (event) => events.push(event)
    })
    const ollamaOutput = mocks.runOllamaChat.mock.calls[0]?.[2] as (chunk: string) => void
    ollamaOutput('token\r\n')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'phase', phase: 'running' }),
        expect.objectContaining({ type: 'output', source: 'stdout', chunk: 'token\r\n' }),
        expect.objectContaining({ type: 'heartbeat', phase: 'running' })
      ])
    )

    ollamaDone.resolve({ result: 'done', isError: false })
    await expect(handle.done).resolves.toMatchObject({ status: 'succeeded' })
    expect(events.at(-1)).toMatchObject({ type: 'finished', status: 'succeeded' })
    expect(vi.getTimerCount()).toBe(0)

    const eventCount = events.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(events).toHaveLength(eventCount)
  })

  it('isolates lifecycle callback failures from the worker result', async () => {
    const child = fakeChild()
    mocks.resolveLaunch.mockResolvedValueOnce({ file: 'claude', args: [] })
    mocks.spawn.mockReturnValueOnce(child)
    const handle = runHeadless('claude', 'task', opts, vi.fn(), {
      onEvent: () => {
        throw new Error('observer failed')
      }
    })
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())

    child.emit('close', 0)

    await expect(handle.done).resolves.toMatchObject({ status: 'succeeded', isError: false })
  })
})
