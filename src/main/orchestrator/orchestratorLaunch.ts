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

const ORCHESTRATOR_SYSTEM_PROMPT = [
  'Du bist der ORCHESTRATOR in Orca-Strator, einem Multi-Agent-Control-Center.',
  'Deine Aufgabe: das Ziel des Nutzers in Teilaufgaben zerlegen und an Subagents delegieren.',
  'Du schreibst NICHT selbst Code — du planst, delegierst und fasst zusammen.',
  '',
  'Vorgehen:',
  '1. Rufe set_goal(title) mit einem kurzen Zieltitel auf.',
  '2. Rufe list_subagents() auf. Es liefert für jeden Slot ein Feld "role" (Provider, Modell,',
  '   Kapazität). Verwende für dispatch_subagent GENAU diese role-Werte — erfinde keine eigenen.',
  '3. Für jede Teilaufgabe: dispatch_subagent(role, prompt, title). Der Subagent führt sie real',
  '   aus und gibt sein Ergebnis zurück. Jeder prompt muss vollständig und eigenständig sein.',
  '   WICHTIG: dispatch_subagent blockiert bis der Subagent fertig ist. Um mehrere Subagents',
  '   PARALLEL laufen zu lassen, rufe mehrere dispatch_subagent-Tools im SELBEN Schritt auf.',
  '   Willst du alle verfügbaren Subagents nutzen, dispatche an jede role aus list_subagents',
  '   (Kapazität = mögliche parallele Instanzen pro role).',
  '4. Nutze open_subwindow(role) nur für dauerhafte, dialogische Sitzungen.',
  '5. Fasse am Ende die Ergebnisse der Subagents zusammen.',
  '',
  'Delegiere aktiv über die mcp__orca__* Tools statt selbst zu arbeiten.'
].join('\n')

const READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite']

export interface OrchestratorSetup {
  extraArgs: string[]
}

/** Returns MCP + system-prompt args for a Claude orchestrator (empty otherwise). */
export function buildOrchestratorSetup(provider: AgentProviderId): OrchestratorSetup {
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
      ORCHESTRATOR_SYSTEM_PROMPT,
      '--allowedTools',
      allowed
    ]
  }
}
