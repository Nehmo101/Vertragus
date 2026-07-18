import { describe, expect, it } from 'vitest'
import { progressState, trimVoiceHistory, type VoiceHistoryTurn } from './useVoiceAssistant'

describe('useVoiceAssistant helpers', () => {
  it('maps progress events to all overlay states', () => {
    expect(progressState({ status: 'listening' })).toBe('listening')
    expect(progressState({ stage: 'transcribing' })).toBe('thinking')
    expect(progressState({ stage: 'acting:start_profile' })).toBe('thinking')
    expect(progressState({ status: 'speaking' })).toBe('speaking')
    expect(progressState({ status: 'failed' })).toBe('error')
    expect(progressState({ status: 'done' })).toBe('idle')
  })

  it('sends only the last ten history turns', () => {
    const history: VoiceHistoryTurn[] = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `turn-${index}`
    }))
    expect(trimVoiceHistory(history)).toHaveLength(10)
    expect(trimVoiceHistory(history)[0]?.content).toBe('turn-4')
  })

  it('does not expose privileged agent or spawn calls in the renderer hook', async () => {
    const source = await import('./useVoiceAssistant?raw').then((module) => module.default as string)
    expect(source).not.toMatch(/\.agents\.|spawnProfile|agents:spawn|agents\/spawn/)
    expect(source).not.toMatch(/Authorization|Bearer|process\.env/)
  })
})
