import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Source-contract regressions for voice-window IPC authorization.
 * Pure unit tests of the extracted guards live in voiceIpc.test.ts; this file
 * locks the wiring in register.ts so spawn/write cannot regress to unguarded.
 */
const registerSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'register.ts'), 'utf8')

function handlerBlock(channelExpr: string): string {
  const match = registerSrc.match(
    new RegExp(
      String.raw`ipcMain\.(?:handle|on)\(\s*IPC\.${channelExpr}\s*,[\s\S]*?\n  \)`,
      'm'
    )
  )
  expect(match, `expected IPC.${channelExpr} handler`).toBeTruthy()
  return match![0]
}

describe('register.ts voice-window authorization wiring', () => {
  it('rejects agents:spawnProfile from the voice overlay window', () => {
    const block = handlerBlock('agentsSpawnProfile')
    expect(block).toMatch(/assertNotVoiceWindow\s*\(/)
  })

  it('rejects agents:spawn from the voice overlay window', () => {
    const block = handlerBlock('agentSpawn')
    expect(block).toMatch(/assertNotVoiceWindow\s*\(/)
  })

  it('drops agents:write from the voice overlay window (auth negative)', () => {
    const block = handlerBlock('agentWrite')
    expect(block).toMatch(/isVoiceWindowSender\s*\(/)
    expect(block).toMatch(/return/)
  })

  it('gates orchestrator:send to the main window before resolution', () => {
    const block = handlerBlock('orchestratorSend')
    expect(block).toMatch(/requireMainWindow\s*\(/)
    expect(block).toMatch(/resolveOrchestratorSend\s*\(/)
  })

  it('allows voiceAssistant:turn only from overlay or main', () => {
    const block = handlerBlock('voiceAssistantTurn')
    expect(block).toMatch(/guardVoiceTurnAllowed\s*\(/)
    expect(block).toMatch(/isVoiceWindowSender/)
    expect(block).toMatch(/isMainWindowSender/)
  })

  it('does not let the voice turn handler call spawnProfile or agent write directly', () => {
    const block = handlerBlock('voiceAssistantTurn')
    expect(block).not.toMatch(/spawnProfileTeam|agentsSpawnProfile|agentManager\.write/)
  })
})
