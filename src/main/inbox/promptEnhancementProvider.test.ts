import { describe, expect, it, vi } from 'vitest'
import type {
  HeadlessHandle,
  HeadlessLifecycleOptions,
  HeadlessResult
} from '@main/agents/headless'
import {
  assertDisposablePromptWorkingDirectory,
  createHeadlessPromptEnhancementExecutor,
  createMainPromptEnhancementService,
  type PromptEnhancementCapacity,
  type PromptHeadlessRunner
} from './promptEnhancementProvider'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function availableCapacity(): PromptEnhancementCapacity & {
  acquireWait: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
} {
  return {
    acquireWait: vi.fn(async () => true),
    release: vi.fn()
  }
}

describe('headless prompt enhancement provider adapter', () => {
  it('rejects provider-context path traversal outside the disposable temp root', () => {
    expect(() =>
      assertDisposablePromptWorkingDirectory('C:\\workspace\\repo', 'C:\\temp')
    ).toThrow(/Path-Traversal/)
    expect(() =>
      assertDisposablePromptWorkingDirectory('C:\\temp\\..\\workspace', 'C:\\temp')
    ).toThrow(/Path-Traversal/)
    expect(() =>
      assertDisposablePromptWorkingDirectory('C:\\temp', 'C:\\temp')
    ).toThrow(/Path-Traversal/)
  })

  it('uses existing headless architecture without Yolo or MCP arguments', async () => {
    const runner = vi.fn<PromptHeadlessRunner>(() => ({
      done: Promise.resolve({ result: '{"ok":true}', isError: false, status: 'succeeded' }),
      kill: vi.fn()
    }))
    const capacity = availableCapacity()
    const executor = createHeadlessPromptEnhancementExecutor(runner, capacity)
    const output = await executor({
      provider: 'codex',
      model: 'configured-model',
      systemPrompt: 'trusted rules',
      userPrompt: 'source data',
      signal: new AbortController().signal
    })

    expect(output).toBe('{"ok":true}')
    expect(runner).toHaveBeenCalledOnce()
    expect(runner.mock.calls[0]?.[1]).toContain('trusted rules\n\n---\n\nsource data')
    expect(runner.mock.calls[0]?.[2]).toMatchObject({
      model: 'configured-model',
      yolo: false,
      systemPrompt: 'trusted rules',
      extraArgs: []
    })
    expect(runner.mock.calls[0]?.[2].workingDir).toMatch(/vertragus-prompt-enhancement-/)
    expect(capacity.acquireWait).toHaveBeenCalledWith('codex', expect.any(Object))
    expect(capacity.release).toHaveBeenCalledWith('codex')
  })

  it('reports capacity-clear, provider progress, and streamed output as activity', async () => {
    let onLine: ((chunk: string) => void) | undefined
    let lifecycle: HeadlessLifecycleOptions | undefined
    const runner = vi.fn<PromptHeadlessRunner>((_id, _prompt, _opts, line, options) => {
      onLine = line
      lifecycle = options
      return {
        done: Promise.resolve({ result: '{"ok":true}', isError: false, status: 'succeeded' }),
        kill: vi.fn()
      }
    })
    const activity = vi.fn()
    const executor = createHeadlessPromptEnhancementExecutor(runner, availableCapacity())
    const output = await executor({
      provider: 'cursor',
      systemPrompt: 'rules',
      userPrompt: 'data',
      signal: new AbortController().signal,
      onActivity: activity
    })

    expect(output).toBe('{"ok":true}')
    // At least one ping fires once the capacity queue clears, before any output.
    expect(activity).toHaveBeenCalled()
    const beforeStream = activity.mock.calls.length
    lifecycle?.onEvent({
      type: 'progress',
      providerEvent: 'system',
      pid: 42,
      phase: 'running',
      timestamp: 1,
      elapsedMs: 1
    })
    expect(activity.mock.calls.length).toBeGreaterThan(beforeStream)
    const beforeVisibleOutput = activity.mock.calls.length
    onLine?.('streamed chunk')
    expect(activity.mock.calls.length).toBeGreaterThan(beforeVisibleOutput)
  })

  it('kills the headless provider when the injected abort signal fires', async () => {
    const done = deferred<HeadlessResult>()
    const kill = vi.fn()
    const handle: HeadlessHandle = { done: done.promise, kill }
    const runner = vi.fn<PromptHeadlessRunner>(() => handle)
    const capacity = availableCapacity()
    const executor = createHeadlessPromptEnhancementExecutor(runner, capacity)
    const controller = new AbortController()
    const output = executor({
      provider: 'claude',
      systemPrompt: 'rules',
      userPrompt: 'data',
      signal: controller.signal
    })

    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce())
    controller.abort()
    expect(kill).toHaveBeenCalledOnce()
    done.resolve({ result: '', isError: true, status: 'cancelled' })
    await expect(output).rejects.toThrow(/abgebrochen/i)
    expect(capacity.release).toHaveBeenCalledWith('claude')
  })

  it('maps a failed headless result to an executor error', async () => {
    const runner = vi.fn<PromptHeadlessRunner>(() => ({
      done: Promise.resolve({
        result: 'login required',
        error: 'login required',
        isError: true,
        status: 'failed'
      }),
      kill: vi.fn()
    }))
    const executor = createHeadlessPromptEnhancementExecutor(runner, availableCapacity())

    await expect(
      executor({
        provider: 'claude',
        systemPrompt: 'rules',
        userPrompt: 'data',
        signal: new AbortController().signal
      })
    ).rejects.toThrow('login required')
  })

  it('keeps health and provider execution injectable in the Main facade', async () => {
    const executeProvider = vi.fn(async () => 'unused')
    const loadProviderHealth = vi.fn(async () => [])
    const service = createMainPromptEnhancementService({ loadProviderHealth, executeProvider })

    await expect(
      service.enhance({
        source: { title: 'Prompt', content: 'Verbessern', artifacts: [] }
      })
    ).resolves.toMatchObject({ status: 'selection-required' })
    expect(loadProviderHealth).toHaveBeenCalledOnce()
    expect(executeProvider).not.toHaveBeenCalled()
  })
})
