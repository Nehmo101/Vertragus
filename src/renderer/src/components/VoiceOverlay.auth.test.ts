import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const overlaySrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'VoiceOverlay.tsx'), 'utf8')
const hookSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../hooks/useVoiceAssistant.ts'),
  'utf8'
)

describe('VoiceOverlay privilege surface (auth negatives)', () => {
  it('must not call agents.spawnProfile or agents.write', () => {
    for (const source of [overlaySrc, hookSrc]) {
      expect(source).not.toMatch(/agents\.spawnProfile|agents\.write|agents:spawnProfile|agents:write/)
      expect(source).not.toMatch(/window\.orca\.agents/)
    }
  })

  it('routes actions only through voiceAssistant.turn / voiceOverlay control', () => {
    expect(hookSrc).toMatch(/voiceAssistant\.turn/)
    expect(hookSrc).toMatch(/voiceOverlay\.hide/)
    expect(overlaySrc).toMatch(/useVoiceAssistant/)
    expect(overlaySrc).not.toMatch(/orchestrator\.send|startAll\s*\(/)
  })
})
