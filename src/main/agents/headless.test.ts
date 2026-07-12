import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveLaunch: vi.fn(),
  spawn: vi.fn()
}))

vi.mock('@main/agents/resolveCommand', () => ({ resolveLaunch: mocks.resolveLaunch }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: mocks.spawn }
})
vi.mock('@main/agents/ollamaHeadless', () => ({ runOllamaChat: vi.fn() }))

import { runHeadless } from './headless'

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
})
