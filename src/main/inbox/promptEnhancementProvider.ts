import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { runHeadless, type HeadlessHandle } from '@main/agents/headless'
import { providerCapacity } from '@main/agents/providerCapacity'
import { checkAllProviders } from '@main/providers/health'
import type { AgentProviderId, ProviderHealth } from '@shared/providers'
import {
  enhanceInboxPrompt,
  type PromptEnhancementProviderExecutor,
  type PromptEnhancementRequest,
  type PromptEnhancementResult
} from './promptEnhancement'

export type PromptHeadlessRunner = typeof runHeadless

export interface PromptEnhancementCapacity {
  acquireWait(provider: AgentProviderId, signal?: { aborted: boolean }): Promise<boolean>
  release(provider: AgentProviderId): void
}

/** Defense in depth: the editing-capable CLI must remain in Orca's disposable temp root. */
export function assertDisposablePromptWorkingDirectory(
  workingDir: string,
  temporaryRoot: string = tmpdir()
): void {
  const root = resolve(temporaryRoot)
  const candidate = resolve(workingDir)
  const rel = relative(root, candidate)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Provider-Arbeitsverzeichnis verletzt die Path-Traversal-Grenze.')
  }
}

/**
 * Uses the existing provider CLIs and their existing account sessions. It never
 * reads API keys, enables Yolo, or attaches Orca/external MCP tools.
 */
export function createHeadlessPromptEnhancementExecutor(
  runner: PromptHeadlessRunner = runHeadless,
  capacity: PromptEnhancementCapacity = providerCapacity
): PromptEnhancementProviderExecutor {
  return async (request) => {
    if (request.signal.aborted) throw new Error('Prompt-Verbesserung abgebrochen.')
    const combinedPrompt = [request.systemPrompt, '---', request.userPrompt].join('\n\n')
    const waitAbort = { aborted: false }
    let handle: HeadlessHandle | undefined
    let workingDir: string | undefined
    let capacityHeld = false
    const abort = (): void => {
      waitAbort.aborted = true
      handle?.kill()
    }
    request.signal.addEventListener('abort', abort, { once: true })
    try {
      capacityHeld = await capacity.acquireWait(request.provider, waitAbort)
      if (!capacityHeld || request.signal.aborted) {
        throw new Error('Prompt-Verbesserung abgebrochen.')
      }
      // A disposable empty CWD prevents an editing-capable agent CLI from reading
      // or mutating the linked repository during this text-only operation.
      const temporaryRoot = tmpdir()
      workingDir = mkdtempSync(resolve(temporaryRoot, 'orca-prompt-enhancement-'))
      assertDisposablePromptWorkingDirectory(workingDir, temporaryRoot)
      handle = runner(
        request.provider,
        combinedPrompt,
        {
          model: request.model,
          workingDir,
          yolo: false,
          systemPrompt: request.systemPrompt,
          extraArgs: []
        },
        () => undefined
      )
      const result = await handle.done
      if (result.status === 'cancelled' || request.signal.aborted) {
        throw new Error('Prompt-Verbesserung abgebrochen.')
      }
      if (result.status === 'failed' || result.isError) {
        throw new Error(result.error || result.result || 'Provider-Ausführung fehlgeschlagen.')
      }
      return result.result
    } finally {
      request.signal.removeEventListener('abort', abort)
      if (capacityHeld) capacity.release(request.provider)
      if (workingDir) {
        try {
          rmSync(workingDir, { recursive: true, force: true })
        } catch {
          // Cleanup failure must not leak provider capacity or replace the provider result.
        }
      }
    }
  }
}

export interface MainPromptEnhancementDependencies {
  loadProviderHealth(): Promise<ProviderHealth[]>
  executeProvider: PromptEnhancementProviderExecutor
}

export interface MainPromptEnhancementService {
  enhance(
    request: Omit<PromptEnhancementRequest, 'providerHealth'>
  ): Promise<PromptEnhancementResult>
}

/**
 * Main integration facade. Callers still resolve Idea/profile/workspace facts
 * from trusted Main stores before calling `enhance`.
 */
export function createMainPromptEnhancementService(
  overrides: Partial<MainPromptEnhancementDependencies> = {}
): MainPromptEnhancementService {
  const dependencies: MainPromptEnhancementDependencies = {
    loadProviderHealth: overrides.loadProviderHealth ?? checkAllProviders,
    executeProvider: overrides.executeProvider ?? createHeadlessPromptEnhancementExecutor()
  }
  return {
    async enhance(request) {
      let providerHealth: ProviderHealth[]
      try {
        providerHealth = await dependencies.loadProviderHealth()
      } catch {
        providerHealth = []
      }
      return enhanceInboxPrompt({ ...request, providerHealth }, dependencies.executeProvider)
    }
  }
}
