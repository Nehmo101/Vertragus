import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runHeadless: vi.fn(),
  listModels: vi.fn(),
  getSetting: vi.fn()
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
vi.mock('@main/providers/models', () => ({
  listModels: mocks.listModels
}))

import { generateProfileForRepo } from './generateProfileForRepo'

describe('generateProfileForRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSetting.mockImplementation((key: string) => {
      if (key === 'providerEnabled') {
        return { claude: true, codex: true, cursor: true, copilot: true, ollama: false }
      }
      if (key === 'disabledModels') return {}
      return undefined
    })
    mocks.listModels.mockResolvedValue({
      claude: { models: ['fable-5'] },
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
      expect.stringContaining('Enabled provider/model catalogue'),
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
})
