import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runHeadless: vi.fn(),
  listModels: vi.fn(),
  getSetting: vi.fn(),
  checkAllProviders: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(async () => ({ isDirectory: () => true }))
}))
vi.mock('@main/config/store', () => ({
  getSetting: mocks.getSetting
}))
vi.mock('@main/agents/headless', () => ({
  runHeadless: mocks.runHeadless
}))
vi.mock('@main/providers/health', () => ({
  checkAllProviders: mocks.checkAllProviders
}))
vi.mock('@main/providers/models', () => ({
  listModels: mocks.listModels
}))

import { generateProfileForRepo } from './generateProfileForRepo'

function health(
  id: string,
  available = true,
  connection: 'connected' | 'disconnected' | 'local' | 'unknown' = 'connected'
): { id: string; available: boolean; connection: string; checkedAt: number } {
  return { id, available, connection, checkedAt: 0 }
}

describe('generateProfileForRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSetting.mockImplementation((key: string) => {
      if (key === 'providerEnabled') {
        return { claude: true, kimi: true, codex: true, cursor: true, copilot: true, ollama: false }
      }
      if (key === 'disabledModels') return {}
      return undefined
    })
    mocks.checkAllProviders.mockResolvedValue([
      health('claude'),
      health('kimi', true, 'unknown'),
      health('codex'),
      health('cursor'),
      health('copilot', true, 'unknown'),
      health('ollama', true, 'local')
    ])
    mocks.listModels.mockResolvedValue({
      claude: { models: ['fable-5'] },
      kimi: { models: ['kimi-k3'] },
      codex: { models: ['gpt-5.6-sol'] },
      cursor: { models: ['composer-2.5-fast'] },
      copilot: { models: ['gpt-5-mini'] },
      ollama: { models: [] }
    })
    mocks.runHeadless.mockReturnValue({
      kill: vi.fn(),
      done: Promise.resolve({
        isError: false,
        result: JSON.stringify({
          name: 'Repo Team',
          maxParallel: 3,
          maxRetries: 2,
          qualityGates: ['corepack pnpm typecheck', 'rm -rf .'],
          agents: [
            {
              role: 'backend',
              provider: 'claude',
              model: 'fable-5',
              count: 1,
              strengths: ['backend'],
              weaknesses: ['visual design']
            },
            {
              role: 'frontend',
              provider: 'cursor',
              model: 'composer-2.5-fast',
              count: 2,
              strengths: ['frontend'],
              weaknesses: ['security review']
            }
          ]
        })
      })
    })
  })

  it('uses the selected model for read-only analysis and returns an adaptive profile', async () => {
    const profile = await generateProfileForRepo({
      workingDir: 'C:\\git\\repo',
      provider: 'claude',
      model: 'fable-5'
    })

    expect(mocks.runHeadless).toHaveBeenCalledWith(
      'claude',
      expect.stringContaining('Active provider/model catalogue'),
      expect.objectContaining({
        model: 'fable-5',
        workingDir: 'C:\\git\\repo',
        yolo: false
      }),
      expect.any(Function)
    )
    expect(profile).toEqual(
      expect.objectContaining({
        name: 'Repo Team',
        workingDir: 'C:\\git\\repo',
        orchestrator: expect.objectContaining({ provider: 'claude', model: 'fable-5' }),
        planner: expect.objectContaining({
          routingMode: 'adaptive',
          maxParallel: 3,
          maxRetries: 2
        })
      })
    )
    expect(profile.agents).toEqual([
      expect.objectContaining({ role: 'backend', provider: 'claude', model: 'fable-5' }),
      expect.objectContaining({
        role: 'frontend',
        provider: 'cursor',
        model: 'composer-2.5-fast',
        count: 2
      })
    ])
    expect(profile.autoPr.qualityGates).toEqual(['corepack pnpm typecheck'])
  })

  it('derives maxParallel from total worker capacity, not the number of roles', async () => {
    mocks.runHeadless.mockReturnValue({
      kill: vi.fn(),
      done: Promise.resolve({
        isError: false,
        result: JSON.stringify({
          name: 'Single Role Team',
          // No maxParallel supplied: the fallback must use total slot capacity.
          agents: [
            {
              role: 'coder',
              provider: 'codex',
              model: 'gpt-5.6-sol',
              count: 3,
              strengths: ['implementation'],
              weaknesses: []
            }
          ]
        })
      })
    })

    const profile = await generateProfileForRepo({
      workingDir: 'C:\\git\\repo',
      provider: 'claude',
      model: 'fable-5'
    })

    // One role definition but three concurrent workers → maxParallel 3, not 1.
    expect(profile.planner.maxParallel).toBe(3)
  })

  it('excludes enabled but inactive providers from the catalogue and remaps their slots', async () => {
    // Copilot is globally enabled but its CLI is not installed; Cursor is
    // installed but logged out. Neither may be suggested or survive in slots.
    mocks.checkAllProviders.mockResolvedValue([
      health('claude'),
      health('kimi', true, 'unknown'),
      health('codex'),
      health('cursor', true, 'disconnected'),
      health('copilot', false, 'unknown'),
      health('ollama', true, 'local')
    ])

    const profile = await generateProfileForRepo({
      workingDir: 'C:\\git\\repo',
      provider: 'claude',
      model: 'fable-5'
    })

    const prompt = mocks.runHeadless.mock.calls[0][1] as string
    const catalogue = JSON.parse(
      prompt.match(/Active provider\/model catalogue[^:]*: (\{.*\})/)?.[1] ?? '{}'
    )
    expect(Object.keys(catalogue).sort()).toEqual(['claude', 'codex', 'kimi'])

    // The generated cursor slot falls back to the analysis provider, and the
    // foreign cursor model id must not carry over onto the fallback provider.
    expect(profile.agents).toEqual([
      expect.objectContaining({ role: 'backend', provider: 'claude', model: 'fable-5' }),
      expect.objectContaining({ role: 'frontend', provider: 'claude', model: '' })
    ])
  })

  it('never orchestrates with an enabled but unavailable provider', async () => {
    // Analysis runs on Kimi; Claude is enabled but its CLI is missing, so the
    // orchestrator fallback must skip it and pick the next active candidate.
    mocks.checkAllProviders.mockResolvedValue([
      health('claude', false, 'unknown'),
      health('kimi', true, 'unknown'),
      health('codex'),
      health('cursor'),
      health('copilot', true, 'unknown'),
      health('ollama', true, 'local')
    ])
    mocks.runHeadless.mockReturnValue({
      kill: vi.fn(),
      done: Promise.resolve({
        isError: false,
        result: JSON.stringify({
          name: 'Repo Team',
          agents: [
            { role: 'backend', provider: 'claude', model: 'fable-5', count: 1 }
          ]
        })
      })
    })

    const profile = await generateProfileForRepo({
      workingDir: 'C:\\git\\repo',
      provider: 'kimi',
      model: 'kimi-k3'
    })

    expect(profile.orchestrator?.provider).toBe('kimi')
    expect(profile.agents).toEqual([
      expect.objectContaining({ role: 'backend', provider: 'kimi', model: '' })
    ])
  })

  it('rejects analysis on a provider that is not active', async () => {
    mocks.checkAllProviders.mockResolvedValue([
      health('claude', false, 'unknown'),
      health('kimi', true, 'unknown'),
      health('codex'),
      health('cursor'),
      health('copilot', true, 'unknown'),
      health('ollama', true, 'local')
    ])

    await expect(
      generateProfileForRepo({ workingDir: 'C:\\git\\repo', provider: 'claude', model: 'fable-5' })
    ).rejects.toThrow('nicht aktiv')
    expect(mocks.runHeadless).not.toHaveBeenCalled()
  })

  it('keeps the enabled-only behaviour when the health probe fails entirely', async () => {
    mocks.checkAllProviders.mockRejectedValue(new Error('probe infrastructure broken'))

    const profile = await generateProfileForRepo({
      workingDir: 'C:\\git\\repo',
      provider: 'claude',
      model: 'fable-5'
    })

    expect(profile.agents).toEqual([
      expect.objectContaining({ role: 'backend', provider: 'claude' }),
      expect.objectContaining({ role: 'frontend', provider: 'cursor' })
    ])
  })
})
