import { describe, expect, it, vi } from 'vitest'
import { workspaceProfileSchema, type WorkspaceProfile } from '@shared/profile'
import { enhanceInboxPrompt } from './promptEnhancement'
import {
  assertAuthorizedPromptEnhancementSender,
  createPromptEnhancementIpcController,
  type PromptIpcEventLike
} from './promptEnhancementIpc'

function event(id = 7, url = 'http://localhost:5173/#/inbox'): PromptIpcEventLike {
  const frame = { url }
  return {
    sender: {
      id,
      isDestroyed: () => false,
      getURL: () => url,
      mainFrame: frame
    },
    senderFrame: frame
  }
}

function authorize(current: PromptIpcEventLike): void {
  assertAuthorizedPromptEnhancementSender(current, {
    developmentUrl: 'http://localhost:5173',
    packagedRendererUrl: 'file:///C:/app/out/renderer/index.html',
    isKnownSender: (sender) => sender.id === 7 || sender.id === 8
  })
}

function profile(): WorkspaceProfile {
  return workspaceProfileSchema.parse({
    id: 'linked-profile',
    name: 'Linked',
    workingDir: '',
    orchestrator: { provider: 'claude', model: 'profile-model' },
    agents: []
  })
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'request_123456789',
    source: {
      title: 'Orca-Strator soll für MacOS nutzbar sein',
      content: 'Bitte konkretisieren.',
      status: 'draft',
      tags: ['desktop'],
      refs: { profileId: 'linked-profile' },
      artifacts: []
    },
    ...overrides
  }
}

const health = [
  { id: 'claude' as const, available: true, connection: 'connected' as const, checkedAt: 1 },
  { id: 'codex' as const, available: true, connection: 'connected' as const, checkedAt: 1 }
]

describe('prompt enhancement Main/IPC boundary', () => {
  it('rejects unauthorized callers, foreign origins and subframes before validation', async () => {
    const unknown = event(99)
    expect(() => authorize(unknown)).toThrow(/Zugriff verweigert|unauthorized/i)
    expect(() => authorize(event(7, 'https://attacker.example'))).toThrow(/Zugriff verweigert/i)
    const subframe = event()
    subframe.senderFrame = { url: 'http://localhost:5173/embedded' }
    expect(() => authorize(subframe)).toThrow(/Zugriff verweigert/i)
    const missingFrame = event()
    missingFrame.senderFrame = null
    expect(() => authorize(missingFrame)).toThrow(/Zugriff verweigert/i)
    const destroyed = event()
    destroyed.sender.isDestroyed = () => true
    expect(() => authorize(destroyed)).toThrow(/Zugriff verweigert/i)

    const controller = createPromptEnhancementIpcController({
      authorize,
      getProfile: () => undefined,
      inspectWorkspace: vi.fn(),
      service: { enhance: vi.fn() }
    })
    await expect(controller.enhance(unknown, { malformed: true })).rejects.toThrow(/Zugriff verweigert/)
  })

  it('rejects malformed request and abort payloads with strict validation', async () => {
    const controller = createPromptEnhancementIpcController({
      authorize,
      getProfile: () => undefined,
      inspectWorkspace: vi.fn(),
      service: { enhance: vi.fn() }
    })
    await expect(controller.enhance(event(), { requestId: '../escape' })).rejects.toThrow(/invalid payload/i)
    expect(() => controller.abort(event(), { requestId: '..\\escape', extra: true })).toThrow(/invalid payload/i)
  })

  it('prefers the Main-loaded linked profile orchestrator over a conflicting explicit provider', async () => {
    const executeProvider = vi.fn(async () => 'invalid-model-response')
    const controller = createPromptEnhancementIpcController({
      authorize,
      getProfile: (id) => (id === 'linked-profile' ? profile() : undefined),
      inspectWorkspace: vi.fn(async (loaded) => ({ name: loaded.name })),
      service: {
        enhance: async (input) =>
          enhanceInboxPrompt({ ...input, providerHealth: health }, executeProvider)
      }
    })
    const result = await controller.enhance(
      event(),
      request({ explicitSelection: { provider: 'codex', model: 'wrong-model' } })
    )
    expect(result).toMatchObject({
      status: 'fallback',
      provider: 'claude',
      model: 'profile-model'
    })
    expect(executeProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude' }))
  })

  it('does not silently choose a Cloud provider when an unsaved draft has no linked profile', async () => {
    const executeProvider = vi.fn(async () => 'unused')
    const controller = createPromptEnhancementIpcController({
      authorize,
      getProfile: () => undefined,
      inspectWorkspace: vi.fn(),
      service: {
        enhance: async (input) =>
          enhanceInboxPrompt({ ...input, providerHealth: health }, executeProvider)
      }
    })
    const raw = request()
    raw.source = { ...(raw.source as object), refs: undefined }
    await expect(controller.enhance(event(), raw)).resolves.toMatchObject({
      status: 'selection-required',
      reason: 'no-profile'
    })
    expect(executeProvider).not.toHaveBeenCalled()
  })

  it('aborts only the matching request owned by the same authorized sender', async () => {
    const service = {
      enhance: vi.fn(async ({ signal }: { signal?: AbortSignal }) =>
        new Promise<{ status: 'aborted'; message: string }>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => resolve({ status: 'aborted', message: 'Die Prompt-Verbesserung wurde abgebrochen.' }),
            { once: true }
          )
        })
      )
    }
    const controller = createPromptEnhancementIpcController({
      authorize,
      getProfile: () => profile(),
      inspectWorkspace: vi.fn(async () => ({ name: 'Linked' })),
      service
    })
    const pending = controller.enhance(event(7), request())
    await vi.waitFor(() => expect(controller.activeCount()).toBe(1))
    expect(controller.abort(event(8), { requestId: 'request_123456789' })).toBe(false)
    expect(controller.abort(event(7), { requestId: 'request_123456789' })).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'aborted' })
    expect(controller.activeCount()).toBe(0)
  })

  it('rejects a traversal-tainted stored workspace before provider execution', async () => {
    const service = { enhance: vi.fn() }
    const controller = createPromptEnhancementIpcController({
      authorize,
      getProfile: () => profile(),
      inspectWorkspace: vi.fn(async () => {
        throw new Error('Workspace path traversal outside root')
      }),
      service
    })
    await expect(controller.enhance(event(), request())).resolves.toMatchObject({
      status: 'invalid-input',
      code: 'invalid-workspace-context'
    })
    expect(service.enhance).not.toHaveBeenCalled()
  })
})
