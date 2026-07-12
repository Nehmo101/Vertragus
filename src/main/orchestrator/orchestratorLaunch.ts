/**
 * Builds the extra CLI args that turn a plain Claude agent into an Orca
 * orchestrator: attaches the Orca MCP server and injects the orchestrator
 * system prompt. Only Claude is wired for now (the user's Fable case); other
 * providers spawn normally until their MCP wiring lands.
 */
import { app } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentProviderId } from '@shared/providers'
import { getMcpHandle } from '@main/orchestrator/mcpHandle'

const orchestratorSystemPrompt = (name: string): string => [
  `Du bist ${name}, der ORCHESTRATOR in Orca-Strator, einem Multi-Agent-Control-Center.`,
  'Deine Aufgabe: das Ziel des Nutzers in Teilaufgaben zerlegen und an Subagents delegieren.',
  'Du schreibst NICHT selbst Code — du planst, delegierst und fasst zusammen.',
  'Dein Subagent-Team läuft bereits in eigenen Fenstern. Über dispatch_subagent/',
  'dispatch_batch startest du zusätzlich dedizierte Worker, die eine konkrete Aufgabe',
  'eigenständig erledigen und dir ihr Ergebnis zurückgeben.',
  '',
  'Vorgehen:',
  '1. Rufe set_goal(title) mit einem kurzen Zieltitel auf.',
  '2. Rufe list_subagents() auf. Es liefert für jeden Slot ein Feld "role" (Provider, Modell,',
  '   Kapazität). Verwende für dispatch_subagent GENAU diese role-Werte — erfinde keine eigenen.',
  '3. Zum Delegieren: Für MEHRERE Teilaufgaben nimm dispatch_batch(tasks=[{role,prompt,title}, …]) —',
  '   sie laufen PARALLEL (begrenzt durch die Kapazität jeder role) und alle Ergebnisse kommen',
  '   zusammen zurück. Für eine einzelne Aufgabe genügt dispatch_subagent(role, prompt, title).',
  '   Jeder prompt muss vollständig und eigenständig sein. Willst du eine role N-mal parallel nutzen',
  '   (Kapazität N), lege N Einträge mit derselben role in dispatch_batch.',
  '4. Nutze open_subwindow(role) nur für dauerhafte, dialogische Sitzungen.',
  '5. Jeder Subagent bekommt einen Mittelerde-Namen (z.B. „Legolas"), der in seinem Ergebnis',
  '   steht. Sprich Subagents in deiner Zusammenfassung mit diesem Namen an.',
  '6. Fasse am Ende die Ergebnisse der Subagents zusammen.',
  '',
  'Delegiere aktiv über die mcp__orca__* Tools statt selbst zu arbeiten.'
].join('\n')

const READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite']

export interface OrchestratorSetup {
  extraArgs: string[]
}

/** Returns MCP + system-prompt args for a Claude orchestrator (empty otherwise). */
export function buildOrchestratorSetup(provider: AgentProviderId, name: string): OrchestratorSetup {
  if (provider !== 'claude') return { extraArgs: [] }
  const handle = getMcpHandle()
  if (!handle) return { extraArgs: [] }

  const configPath = join(app.getPath('userData'), 'orca-mcp.json')
  writeFileSync(
    configPath,
    JSON.stringify({ mcpServers: { orca: { type: 'http', url: handle.url } } }, null, 2)
  )

  const allowed = [...handle.allowedTools, ...READONLY_TOOLS].join(',')
  return {
    extraArgs: [
      '--mcp-config',
      configPath,
      '--strict-mcp-config',
      '--append-system-prompt',
      orchestratorSystemPrompt(name),
      '--allowedTools',
      allowed
    ]
  }
}
