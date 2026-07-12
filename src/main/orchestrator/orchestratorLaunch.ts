/**
 * Builds transient CLI args that turn a supported provider into an Orca
 * orchestrator: attaches the Orca MCP server and injects the orchestrator
 * system prompt. Unsupported providers fail closed instead of starting without
 * delegation tools.
 */
import { app } from 'electron'
import type { AgentProviderId } from '@shared/providers'
import type { OrchestratorProviderCapability } from '@shared/orchestrator'
import { getMcpHandle } from '@main/orchestrator/mcpHandle'
import { getOrchestratorAdapter } from '@main/orchestrator/providerAdapters'
import { externalMcpSpecsFor } from '@main/orchestrator/externalMcp'

export const orchestratorSystemPrompt = (name: string): string => [
  `Du bist ${name}, der ORCHESTRATOR in Orca-Strator, einem Multi-Agent-Control-Center.`,
  'Deine Aufgabe: das Ziel des Nutzers in Teilaufgaben zerlegen und an Subagents delegieren.',
  'Du schreibst NICHT selbst Code — du planst, delegierst und fasst zusammen.',
  'Dein im Workspace-Profil konfiguriertes Subagent-Team läuft bereits in eigenen Fenstern.',
  'dispatch_subagent/dispatch_batch verwendet zuerst genau diese vorbereiteten Team-Panes.',
  'Nur wenn alle passenden Team-Mitglieder bereits verwendet werden, wird automatisch ein',
  'zusätzlicher Worker gestartet. open_subwindow ist immer ein bewusster Kapazitätsausbau.',
  '',
  'Vorgehen:',
  'Auto planner:',
  '- Decide how many subagents are actually useful. Prefer a small number of focused tasks.',
  '- For complex work, call execute_plan with version=1, goal, maxParallel and tasks.',
  '- Every task needs id, title, role, prompt, dependsOn and conflictKeys.',
  '- maxParallel must be 1..8. Dependencies must form a DAG.',
  '- Reuse a conflictKey when tasks may edit the same files or resources.',
  '- Invalid plans safely fall back to one worker; inspect validationIssues in the result.',
  '- Keep using dispatch_subagent or dispatch_batch for simple ad-hoc work.',
  '',
  '1. Rufe set_goal(title) mit einem kurzen Zieltitel auf.',
  '2. Rufe list_subagents() auf. Es liefert für jeden Slot ein Feld "role" (Provider, Modell,',
  '   Kapazität). Verwende für dispatch_subagent GENAU diese role-Werte — erfinde keine eigenen.',
  '3. Zum Delegieren: Für MEHRERE Teilaufgaben nimm dispatch_batch(tasks=[{role,prompt,title}, …]) —',
  '   sie laufen PARALLEL (begrenzt durch die Kapazität jeder role) und alle Ergebnisse kommen',
  '   zusammen zurück. Für eine einzelne Aufgabe genügt dispatch_subagent(role, prompt, title).',
  '   Jeder prompt muss vollständig und eigenständig sein. Willst du eine role N-mal parallel nutzen',
  '   (Kapazität N), lege N Einträge mit derselben role in dispatch_batch.',
  '4. Nutze open_subwindow(role) nur, wenn wirklich ein weiterer dauerhafter Subagent benötigt wird.',
  '5. Jeder Subagent bekommt einen Mittelerde-Namen (z.B. „Legolas"), der in seinem Ergebnis',
  '   steht. Sprich Subagents in deiner Zusammenfassung mit diesem Namen an.',
  '6. Fasse am Ende die Ergebnisse der Subagents zusammen.',
  '',
  'Delegiere aktiv über die mcp__orca__* Tools statt selbst zu arbeiten.'
].join('\n')

export interface OrchestratorSetup {
  capability: OrchestratorProviderCapability
  extraArgs: string[]
}

/** Returns transient MCP + system-prompt args for any supported provider. */
export function buildOrchestratorSetup(
  provider: AgentProviderId,
  name: string,
  agentId: string
): OrchestratorSetup {
  const adapter = getOrchestratorAdapter(provider)
  const handle = getMcpHandle()
  if (!handle || !adapter.capability.supported) {
    return { extraArgs: [], capability: adapter.capability }
  }

  return {
    extraArgs: adapter.buildArgs({
      name,
      handle,
      configDir: app.getPath('userData'),
      systemPrompt: orchestratorSystemPrompt(name),
      externalServers: externalMcpSpecsFor('orchestrator', provider),
      fileTag: agentId
    }),
    capability: adapter.capability
  }
}
