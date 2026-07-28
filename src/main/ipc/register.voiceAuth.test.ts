import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

/**
 * Voice-window IPC authorization contract (manifest edition). Pure unit tests
 * of the extracted guards live in voiceIpc.test.ts; the central enforcement
 * pipeline is covered in registerManifest.test.ts. This file locks WHICH
 * channels declare which level, so spawn/write cannot regress to unguarded —
 * plus a behavioral spot check that the declared level actually rejects a
 * voice-overlay sender through the real guard.
 */
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

import { ipcManifest } from '@shared/ipcManifest'
import {
  createManifestChannelHandler,
  type RegisterableManifestKey
} from './registerManifest'
import { guardNotVoiceWindow, VOICE_WINDOW_FORBIDDEN } from '@main/voice/voiceIpc'

const registerSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'register.ts'), 'utf8')

function voiceAssistantTurnBody(): string {
  const match = registerSrc.match(/voiceAssistantTurn:\s*async \(event, request\)[\s\S]*?\n {4}\},/)
  expect(match, 'expected voiceAssistantTurn handler in the map').toBeTruthy()
  return match![0]
}

describe('voice-window authorization declarations', () => {
  // The voice overlay shares the renderer preload, so every privileged
  // orchestrator mutation + command-executing channel must refuse it. These
  // are the escalation primitives (approve plans, auto-resolve tool prompts,
  // global YOLO, persist an executable MCP command) the guard exists to block.
  it.each([
    'agentSpawn',
    'agentsSpawnProfile',
    'agentWrite',
    'agentMarkInteractiveUsed',
    'agentResize',
    'agentKill',
    'agentsKillAll',
    'agentsClean',
    'agentPopout',
    'agentHandoff',
    'agentsBulkHandoff',
    'orchestratorReset',
    'orchestratorEnableAutoMode',
    'orchestratorSetPlannerMode',
    'orchestratorSetYoloMaster',
    'orchestratorReviewPlan',
    'orchestratorApprovePublication',
    'orchestratorRejectPublication',
    'orchestratorResolvePermission',
    'orchestratorSetBudgetCaps',
    'orchestratorPauseTask',
    'orchestratorResumeTask',
    'orchestratorResumeInterruptedTask',
    'orchestratorFallbackTask',
    'mcpSave',
    'gitSwitchBranch',
    'githubRepoBind',
    'githubRepoSearch',
    'githubAuthLogin',
    'githubAuthLogout',
    'profileGenerateForRepo'
  ] as const)("declares %s as 'not-voice'", (key) => {
    expect(ipcManifest[key].auth).toBe('not-voice')
  })

  it("gates orchestrator:send to the main window", () => {
    expect(ipcManifest.orchestratorSend.auth).toBe('main-window')
    const handler = registerSrc.match(/orchestratorSend:[\s\S]*?resolveOrchestratorSend\s*\(/)
    expect(handler, 'orchestratorSend must resolve via resolveOrchestratorSend').toBeTruthy()
  })

  it('allows voiceAssistant:turn only from overlay or main (bespoke guard in the body)', () => {
    expect(ipcManifest.voiceAssistantTurn.auth).toBe('custom')
    const body = voiceAssistantTurnBody()
    expect(body).toMatch(/guardVoiceTurnAllowed\s*\(/)
    expect(body).toMatch(/isVoiceWindowSender/)
    expect(body).toMatch(/isMainWindowSender/)
  })

  it('does not let the voice turn handler call spawnProfile or agent write directly', () => {
    const body = voiceAssistantTurnBody()
    expect(body).not.toMatch(/spawnProfileTeam|agentsSpawnProfile|agentManager\.write/)
  })
})

describe('declared levels reject a voice-overlay sender through the real guard', () => {
  const voiceEvent = { sender: { __voice: true } } as unknown as Electron.IpcMainInvokeEvent
  const deps = {
    assertNotVoiceWindow: (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) =>
      guardNotVoiceWindow(Boolean((event.sender as unknown as { __voice?: boolean }).__voice)),
    requireMainWindow: () => {},
    isVoiceWindowSender: (sender: Electron.WebContents) =>
      Boolean((sender as unknown as { __voice?: boolean }).__voice)
  }

  function run(key: RegisterableManifestKey, handler: () => unknown): unknown {
    return createManifestChannelHandler(
      key,
      handler as Parameters<typeof createManifestChannelHandler>[1],
      deps
    )(voiceEvent)
  }

  it('rejects agents:spawn from the voice overlay window', () => {
    const handler = vi.fn()
    expect(() => run('agentSpawn', handler)).toThrow(VOICE_WINDOW_FORBIDDEN)
    expect(handler).not.toHaveBeenCalled()
  })

  it('drops agents:write from the voice overlay window (auth negative, no reply)', () => {
    const handler = vi.fn()
    expect(run('agentWrite', handler)).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })
})
