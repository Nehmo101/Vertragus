/**
 * Builds transient CLI args for an Efficiency-Solo agent: one agent works on
 * the goal directly. Compared to buildOrchestratorSetup this skips the entire
 * orchestrator contract (~90 prompt lines) and attaches only the minimal solo
 * MCP session (report_activity, record_retro) — the fixed token cost per turn
 * is a fraction of the orchestrator's. The reviewed retro-learnings overlay is
 * injected unchanged, so the solo agent still benefits from team knowledge.
 */
import { app } from 'electron'
import type { AgentProviderId } from '@shared/providers'
import type { OrchestratorProviderCapability } from '@shared/orchestrator'
import { getMcpHandle, SOLO_ALLOWED_TOOLS } from '@main/orchestrator/mcpHandle'
import { getOrchestratorAdapter } from '@main/orchestrator/providerAdapters'
import { externalMcpSpecsFor } from '@main/orchestrator/externalMcp'
import { getPromptOverlay } from '@main/orchestrator/promptOverlay'

export interface SoloPolicyOptions {
  engineId?: string
  /** Reviewed learnings overlay (retro branch) injected into the prompt. */
  overlayText?: string
}

export const soloSystemPrompt = (
  name: string,
  options: SoloPolicyOptions = {}
): string => [
  `Du bist ${name}, ein SOLO-Agent in Vertragus. Du erledigst das Ziel des Nutzers DIREKT selbst — es gibt keine Subagents und keine Delegation.`,
  'Arbeitsvertrag:',
  '- Verstehe das Ziel, arbeite fokussiert und verifiziere dein Ergebnis selbst (Tests, Typecheck, Lint, konkrete Belege).',
  '- Melde Phasenwechsel knapp über report_activity (planning → monitoring → summarizing → completed/blocked).',
  '- Führe kein git add, commit, cherry-pick oder push aus; der Vertragus-Main-Prozess sichert Änderungen zentral.',
  '- Beende erst, wenn das Ziel nachweislich erfüllt ist oder eine konkrete Sackgasse eine Nutzerentscheidung braucht.',
  '- Rufe am Ende record_retro mit einem ehrlichen Fazit und Modell-Erkenntnissen (Stärke UND Schwäche, nur mit Beleg) auf.',
  ...(options.overlayText
    ? [
        '',
        'Gelerntes Teamwissen (aus geprüften Retros früherer Läufe; verbindlich zu berücksichtigen):',
        options.overlayText
      ]
    : [])
].join('\n')

export interface SoloSetup {
  capability: OrchestratorProviderCapability
  extraArgs: string[]
}

/** Returns transient MCP + system-prompt args for a solo agent. */
export function buildSoloSetup(
  provider: AgentProviderId,
  name: string,
  agentId: string,
  workspaceSessionId?: string,
  policy: SoloPolicyOptions = {}
): SoloSetup {
  const adapter = getOrchestratorAdapter(provider)
  const handle = getMcpHandle()
  if (!handle || !adapter.capability.supported) {
    // Solo mode degrades gracefully: without MCP support the agent still runs,
    // it just lacks the report/retro tools and the overlay prompt.
    return { extraArgs: [], capability: adapter.capability }
  }
  const url = new URL(handle.url)
  url.searchParams.set('solo', agentId)
  if (workspaceSessionId) url.searchParams.set('workspaceSession', workspaceSessionId)
  if (policy.engineId) url.searchParams.set('engineId', policy.engineId)
  const scopedHandle = { ...handle, url: url.toString(), allowedTools: SOLO_ALLOWED_TOOLS }

  const overlayText = policy.overlayText ?? getPromptOverlay()

  return {
    extraArgs: adapter.buildArgs({
      name,
      handle: scopedHandle,
      configDir: app.getPath('userData'),
      systemPrompt: soloSystemPrompt(name, { ...policy, overlayText }),
      externalServers: externalMcpSpecsFor('subagent', provider),
      fileTag: agentId
    }),
    capability: adapter.capability
  }
}
