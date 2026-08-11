import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }))

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }))

import {
  shouldCreateProcessGroup,
  terminateProcessTree,
  terminateProcessTreeWithEscalation
} from '@main/agents/processTermination'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('shouldCreateProcessGroup', () => {
  it('creates independent process groups on macOS and Linux only', () => {
    expect(shouldCreateProcessGroup('darwin')).toBe(true)
    expect(shouldCreateProcessGroup('linux')).toBe(true)
    expect(shouldCreateProcessGroup('win32')).toBe(false)
  })
})

describe('terminateProcessTree on POSIX', () => {
  it('signals the full process group through its negative PID', () => {
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
    const fallback = vi.fn()

    terminateProcessTree(4711, fallback, 'SIGTERM', 'darwin', true)

    expect(signal).toHaveBeenCalledWith(-4711, 'SIGTERM')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back to the direct process when group signalling fails', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('missing process group')
    })
    const fallback = vi.fn()

    terminateProcessTree(4711, fallback, 'SIGKILL', 'darwin', true)

    expect(fallback).toHaveBeenCalledWith('SIGKILL')
  })

  it('uses the direct process when no PID was assigned', () => {
    const signal = vi.spyOn(process, 'kill')
    const fallback = vi.fn()

    terminateProcessTree(undefined, fallback, 'SIGTERM', 'darwin')

    expect(signal).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledWith('SIGTERM')
  })

  it('never signals an unowned process group through a negative PID', () => {
    const signal = vi.spyOn(process, 'kill')
    const fallback = vi.fn()

    terminateProcessTree(4711, fallback, 'SIGTERM', 'darwin', false)

    expect(signal).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledWith('SIGTERM')
  })
})

describe('termination escalation', () => {
  it('escalates an owned POSIX process group from SIGTERM to SIGKILL after the grace period', () => {
    vi.useFakeTimers()
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
    const fallback = vi.fn()
    const isCurrent = vi.fn(() => true)

    terminateProcessTreeWithEscalation(4711, fallback, isCurrent, 'darwin', true, 100)

    expect(signal).toHaveBeenCalledWith(-4711, 'SIGTERM')
    vi.advanceTimersByTime(100)
    expect(isCurrent).toHaveBeenCalledWith(4711)
    expect(signal).toHaveBeenLastCalledWith(-4711, 'SIGKILL')
  })

  it('does not signal a reused PID after ownership has changed', () => {
    vi.useFakeTimers()
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
    const fallback = vi.fn()

    terminateProcessTreeWithEscalation(4711, fallback, () => false, 'darwin', true, 100)
    vi.advanceTimersByTime(100)

    expect(signal).toHaveBeenCalledTimes(1)
    expect(signal).toHaveBeenCalledWith(-4711, 'SIGTERM')
  })

  it('cancels escalation after the owned child exits', () => {
    vi.useFakeTimers()
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
    const cancel = terminateProcessTreeWithEscalation(
      4711,
      vi.fn(),
      () => true,
      'darwin',
      true,
      100
    )

    cancel()
    vi.advanceTimersByTime(100)

    expect(signal).toHaveBeenCalledTimes(1)
  })
})

describe('terminateProcessTree on Windows', () => {
  it('keeps taskkill tree termination and falls back if taskkill fails', () => {
    mocks.execFile.mockImplementationOnce((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null) => void
    ) => {
      callback(new Error('taskkill failed'))
    })
    const fallback = vi.fn()

    terminateProcessTree(4711, fallback, 'SIGTERM', 'win32')

    expect(mocks.execFile).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4711', '/T', '/F'],
      { windowsHide: true },
      expect.any(Function)
    )
    expect(fallback).toHaveBeenCalledWith('SIGTERM')
  })
})
