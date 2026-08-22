import { describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@shared/schema/provider'
import { providerPreset } from './presets'
import {
  checkAllProviderAuth,
  checkProviderAuth,
  classifyAuthOutput,
  loginCommand,
  type AuthStatusDependencies
} from './authStatus'

const NOW = 1_800_000_000_000

function preset(id: string): ProviderConfig {
  const config = providerPreset(id)
  if (!config) throw new Error(`missing preset ${id}`)
  return config
}

function deps(overrides: Partial<AuthStatusDependencies> = {}): Partial<AuthStatusDependencies> {
  return {
    exec: vi.fn(async () => ''),
    now: () => NOW,
    ...overrides
  }
}

describe('classifyAuthOutput', () => {
  it('reads the sentence, not the exit code', () => {
    expect(classifyAuthOutput('Not logged in')).toBe('logged-out')
    expect(classifyAuthOutput('Authentication required\nRun agent login')).toBe('logged-out')
    expect(classifyAuthOutput('  \nUnauthorized')).toBe('logged-out')
    expect(classifyAuthOutput('Logged in as ada@example.com')).toBe('logged-in')
  })

  it('calls silence unknown rather than fine', () => {
    expect(classifyAuthOutput('')).toBe('unknown')
    expect(classifyAuthOutput('   \n\n  ')).toBe('unknown')
  })
})

describe('loginCommand', () => {
  it('names the executable Vertragus launches, not the vendor alias', () => {
    expect(loginCommand(preset('cursor'))).toBe('cursor-agent login')
    expect(loginCommand(preset('claude'))).toBe('claude auth login')
  })

  it('stays absent when the descriptor declares no login args', () => {
    const config: ProviderConfig = { ...preset('cursor'), auth: { loginArgs: [] } }
    expect(loginCommand(config)).toBeUndefined()
    expect(loginCommand({ ...preset('cursor'), auth: undefined })).toBeUndefined()
  })
})

describe('checkProviderAuth', () => {
  it('runs the declared status probe with the health timeout', async () => {
    const exec = vi.fn(async () => 'Logged in as ada@example.com\n')
    const status = await checkProviderAuth(preset('cursor'), deps({ exec }))
    expect(exec).toHaveBeenCalledWith('cursor-agent', ['status'], 6_000)
    expect(status).toEqual({
      id: 'cursor',
      state: 'logged-in',
      detail: 'Logged in as ada@example.com',
      loginCommand: 'cursor-agent login',
      checkedAt: NOW
    })
  })

  it('reports a logged-out CLI that still exits zero', async () => {
    const status = await checkProviderAuth(
      preset('cursor'),
      deps({ exec: async () => 'Not logged in\n' })
    )
    expect(status.state).toBe('logged-out')
    expect(status.detail).toBe('Not logged in')
  })

  it('runs nothing for a provider without a status probe and says unknown', async () => {
    const exec = vi.fn(async () => 'irrelevant')
    // Kimi's login is a device-code flow; the CLI exposes no status command.
    const status = await checkProviderAuth(preset('kimi'), deps({ exec }))
    expect(exec).not.toHaveBeenCalled()
    expect(status).toEqual({
      id: 'kimi',
      state: 'unknown',
      loginCommand: 'kimi login',
      checkedAt: NOW
    })
  })

  it('treats an empty statusArgs list as no probe at all', async () => {
    const exec = vi.fn(async () => 'irrelevant')
    const config: ProviderConfig = {
      ...preset('cursor'),
      auth: { loginArgs: ['login'], statusArgs: [] }
    }
    const status = await checkProviderAuth(config, deps({ exec }))
    expect(exec).not.toHaveBeenCalled()
    expect(status.state).toBe('unknown')
  })

  it('keeps an uninstalled CLI unknown — ENOENT says nothing about credentials', async () => {
    const status = await checkProviderAuth(
      preset('cursor'),
      deps({
        exec: async () => {
          throw new Error('spawn cursor-agent ENOENT')
        }
      })
    )
    expect(status.state).toBe('unknown')
    expect(status.detail).toMatch(/ENOENT/)
    expect(status.loginCommand).toBe('cursor-agent login')
  })

  it('reads a non-zero exit that names the auth failure as logged-out', async () => {
    const status = await checkProviderAuth(
      preset('cursor'),
      deps({
        exec: async () => {
          throw new Error('Authentication required')
        }
      })
    )
    expect(status.state).toBe('logged-out')
    expect(status.detail).toBe('Authentication required')
  })

  it('never throws, whatever the runner rejects with', async () => {
    const status = await checkProviderAuth(
      preset('cursor'),
      deps({
        exec: async () => {
          throw 'not an error object'
        }
      })
    )
    expect(status.state).toBe('unknown')
    expect(status.detail).toBe('not an error object')
  })
})

describe('checkAllProviderAuth', () => {
  it('probes in parallel and answers one entry per provider', async () => {
    const started: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const exec = vi.fn(async (command: string) => {
      started.push(command)
      if (command === 'cursor-agent') await gate
      return 'Logged in'
    })
    const pending = checkAllProviderAuth(
      [preset('cursor'), preset('claude'), preset('kimi')],
      deps({ exec })
    )
    // The slow CLI has not answered yet and the next one is already running.
    await vi.waitFor(() => expect(started).toEqual(['cursor-agent', 'claude']))
    release?.()

    const statuses = await pending
    expect(statuses.map((entry) => entry.id)).toEqual(['cursor', 'claude', 'kimi'])
    expect(statuses.map((entry) => entry.state)).toEqual(['logged-in', 'logged-in', 'unknown'])
  })
})
