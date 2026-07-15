import { describe, expect, it, vi } from 'vitest'
import type { AgentProviderId } from '@shared/providers'
import { PermissionBroker, providerPermissionAdapters } from './PermissionBroker'

const prompts: Record<Exclude<AgentProviderId, 'ollama'>, string> = {
  claude: 'Claude Code permission: Allow tool Bash? [y/n]',
  codex: 'Codex sandbox approval: Allow tool shell? [y/n]',
  cursor: 'Cursor Agent permission: Allow tool terminal? [y/n]',
  copilot: 'GitHub Copilot permission: Allow tool edit? [y/n]'
}

describe('PermissionBroker provider contract', () => {
  for (const provider of ['claude', 'codex', 'cursor', 'copilot'] as const) {
    it(`${provider}: prompt -> pending -> allow/deny stays internal`, () => {
      const broker = new PermissionBroker(5_000)
      const allow = vi.fn()
      const first = broker.inspectOutput({ provider, agentId: `${provider}-1`, yolo: false }, prompts[provider], allow)
      expect(first?.provider).toBe(provider)
      expect(broker.resolve(first!.id, 'allow')).toBe(true)
      expect(allow).toHaveBeenCalledWith('y\r')

      const deny = vi.fn()
      const second = broker.inspectOutput({ provider, agentId: `${provider}-2`, yolo: false }, prompts[provider], deny)
      expect(broker.resolve(second!.id, 'deny')).toBe(true)
      expect(deny).toHaveBeenCalledWith('n\r')
    })
  }

  it('Ollama is explicitly unsupported and never opens a remote prompt', () => {
    const broker = new PermissionBroker()
    expect(providerPermissionAdapters.ollama.coverage).toBe('unsupported')
    expect(broker.inspectOutput({ provider: 'ollama', agentId: 'o-1', yolo: false }, 'Allow tool?', vi.fn()))
      .toBeUndefined()
  })

  it('defaults to deny when the decision times out', () => {
    vi.useFakeTimers()
    const broker = new PermissionBroker(1_000, () => 10)
    const respond = vi.fn()
    const request = broker.inspectOutput(
      { provider: 'claude', agentId: 'claude-timeout', yolo: false },
      prompts.claude,
      respond
    )
    vi.advanceTimersByTime(1_000)
    expect(respond).toHaveBeenCalledWith('n\r')
    expect(broker.list()).toEqual([])
    expect(broker.resolve(request!.id, 'allow')).toBe(false)
    vi.useRealTimers()
  })
})
