/**
 * Worker execution contract + terminal-result judgement, extracted from
 * Engine.ts (audit A1, pick 1). Pure, side-effect-free functions: the prompt
 * contract appended to every dispatched task and the resolution of
 * contradictory provider signals into one terminal judgement. Engine re-exports
 * these names, so existing imports from './Engine' keep working.
 */
import type { AgentProviderId } from '@shared/providers'
import {
  hasExplicitWorkerBlocker,
  hasExplicitWorkerSuccess,
  type HeadlessResult
} from '@main/agents/headless'

export function platformExecutionGuidance(
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform === 'win32') {
    return [
      'Windows/PowerShell: Nutze pro Tool-Aufruf einen kurzen Einzelbefehl.',
      "Windows/PowerShell: Nutze rg -g (z. B. rg -g '*.ts' Muster) statt Shell-Pfadglobs wie src/**/*.ts.",
      "Windows/PowerShell: rg mit Exit-Code 1 und leerem stderr bedeutet 'keine Treffer', nicht Infrastrukturfehler.",
      'Windows/PowerShell: Vereinfache nach Parser- oder Quotingfehlern den Aufruf; wiederhole ihn nicht unveraendert.'
    ]
  }
  if (platform === 'darwin') {
    return [
      'macOS/zsh: Nutze zsh-kompatible Befehle und beachte die BSD-Varianten von Tools wie sed, stat und date.'
    ]
  }
  return []
}

export function providerExecutionGuidance(
  provider: AgentProviderId,
  yolo: boolean,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (provider !== 'codex' || yolo || platform !== 'win32') return []
  return [
    'Codex/Windows-Safe-Sandbox: Wenn ausschliesslich ein Node-Unterprozess mit spawn EPERM scheitert, ist das ein bekannter Sandbox-Gate-Fehler und kein fachlicher BLOCKER.',
    'Codex/Windows-Safe-Sandbox: Fuehre Vitest zuerst mit "--pool=threads --no-file-parallelism" aus — der Threads-Pool vermeidet die vom Sandbox-Token blockierten Kindprozess-Spawns des Forks-Pools und laesst viele Suiten trotz Sandbox laufen.',
    'Codex/Windows-Safe-Sandbox: Scheitert auch das, arbeite weiter, kennzeichne nur den betroffenen Test/Build als nicht ausfuehrbar und schliesse bei fachlich vollstaendiger Arbeit mit ERGEBNIS: ERFOLG; der Vertragus-Main-Prozess wiederholt die zentralen Abnahme-Gates ausserhalb der Worker-Sandbox.'
  ]
}

/**
 * The per-worker execution contract appended to a dispatched task's prompt.
 *
 * The Vertragus subagent reporting tools (report_progress / post_finding /
 * list_findings / ask_orchestrator) are only demanded when the worker's provider
 * actually receives them (`vertragusSubTools`). Providers without a verified per-agent
 * MCP channel — Cursor today — are never asked to call tools they do not have,
 * so a missing progress/finding stream is an expected capability gap rather than
 * a contract violation. Pure and side-effect-free for direct unit testing.
 */
export function subagentExecutionContract(input: {
  provider: AgentProviderId
  yolo: boolean
  vertragusSubTools: boolean
  securityChecklist: readonly string[]
  platform?: NodeJS.Platform
}): string[] {
  const { provider, yolo, vertragusSubTools, securityChecklist, platform } = input
  return [
    'Vertragus-Ausführungsvertrag:',
    '- Bearbeite nur die beauftragte Fachaufgabe und die erwarteten Dateien.',
    '- Führe relevante Tests, Typecheck und Lint aus.',
    '- Führe kein git add, commit, cherry-pick oder push aus; der Vertragus-Main-Prozess sichert Änderungen zentral.',
    '- Bei Infrastrukturblockern antworte strukturiert und knapp: Blocker, Alternativen, geplante Dateien, Schnittstellen.',
    '- Ergebnisvertrag am Ende: (1) geänderte Dateien, (2) Tests mit grün/gesamt, (3) Typecheck-/Lint-Status, (4) Integrationshinweise.',
    '- Schließe exakt mit ERGEBNIS: ERFOLG oder ERGEBNIS: BLOCKER samt konkreter Begründung.',
    '- Automatisch injizierte Security-Negativfälle: securityGate.ts bewertet nur hinzugefügte Diff-Zeilen.',
    '- Neue Zeilen mit process.env, Bearer, Authorization, Secret-Literalen, writeFileSync, appendFileSync, createWriteStream, rm oder child_process-Aufrufen brauchen passende Missbrauchs-/Injection-/Leak-Negativtests in Testdateien.',
    ...(vertragusSubTools
      ? [
          '- Live-Status: Melde wichtige Phasenwechsel und Zwischenstände knapp über das MCP-Tool report_progress (Server vertragus-sub).',
          '- Team-Board: Teile Schnittstellen, Entscheidungen und Blocker, die parallele Tasks betreffen, über post_finding; prüfe mit list_findings die Einträge anderer Subagents, bevor du gemeinsame Schnittstellen festlegst.',
          '- Direkte Hilfe: Wenn eine Richtungsentscheidung, Freigabe oder Unterstützung fehlt, nutze ask_orchestrator und warte mit await_orchestrator_response auf die konkrete Antwort.'
        ]
      : []),
    ...providerExecutionGuidance(provider, yolo, platform).map((item) => `- ${item}`),
    ...platformExecutionGuidance(platform).map((item) => `- ${item}`),
    ...securityChecklist.map((item) => `- Security-Pflicht: ${item}`)
  ]
}

export interface WorkerTerminalJudgement {
  status: 'success' | 'error' | 'stopped'
  failureKind?: 'infrastructure' | 'worker' | 'cancelled'
  /**
   * Exit 0 without an explicit worker contract while the provider flagged an
   * error: contradictory signals. The acceptance gates may overrule this error.
   */
  unconfirmed?: boolean
  reason: string
}

/**
 * esbuild (and other native build helpers) fail to spawn their child process
 * under the codex restricted-token sandbox with `spawn EPERM`. This is an
 * infrastructure limit, not a code defect — detect it in the worker's output.
 */
function isSandboxSpawnFailure(text: string | undefined): boolean {
  if (!text) return false
  return /\bspawn\b[^\n]*\bEPERM\b/i.test(text) ||
    /\bEPERM\b[^\n]*\bspawn\b/i.test(text) ||
    /esbuild[^\n]*\bEPERM\b/i.test(text)
}

/** Resolve contradictory provider flags using process outcome and the worker's explicit contract. */
export function judgeWorkerTerminalResult(result: HeadlessResult): WorkerTerminalJudgement {
  if (result.status === 'cancelled') {
    return {
      status: 'stopped',
      failureKind: 'cancelled',
      reason: 'Der Worker wurde durch den Stop-Mechanismus abgebrochen.'
    }
  }

  const infrastructureFailure =
    result.failureKind === 'provider-auth' ||
    result.failureKind === 'sandbox' ||
    result.failureKind === 'stalled'
  if (infrastructureFailure) {
    return {
      status: 'error',
      failureKind: 'infrastructure',
      reason: result.error?.trim() ||
        `Provider-Infrastruktur fehlgeschlagen (${result.failureKind}).`
    }
  }

  // A worker that only fails because esbuild cannot spawn its native child in
  // the codex restricted-token sandbox is hitting an infrastructure limit, not
  // producing bad code. The retro analysis already treats EPERM as infra
  // (runAnalysis.ts); classify it here too so such a run does not count as a
  // model/worker failure — even when the worker mistakenly self-reports BLOCKER.
  if (isSandboxSpawnFailure(result.result) || isSandboxSpawnFailure(result.error)) {
    return {
      status: 'error',
      failureKind: 'infrastructure',
      reason: 'Sandbox-Gate-Fehler: esbuild/Node-Unterprozess scheiterte an spawn EPERM (kein fachlicher BLOCKER).'
    }
  }

  if (hasExplicitWorkerBlocker(result.result)) {
    return {
      status: 'error',
      failureKind: 'worker',
      reason: 'Der Worker meldete explizit ERGEBNIS: BLOCKER.'
    }
  }

  if (result.exitCode === 0 && hasExplicitWorkerSuccess(result.result)) {
    return {
      status: 'success',
      reason: 'Provider-Prozess endete mit Exit-Code 0 und expliziter ERGEBNIS: ERFOLG-Meldung.'
    }
  }

  if (result.status === 'succeeded' && !result.isError) {
    return { status: 'success', reason: 'Der Provider meldete einen erfolgreichen Worker-Abschluss.' }
  }
  if (result.status == null && !result.isError) {
    return { status: 'success', reason: 'Der kompatible Provider-Adapter meldete keinen Fehler.' }
  }

  if (result.exitCode === 0) {
    return {
      status: 'error',
      failureKind: 'worker',
      unconfirmed: true,
      reason: 'Der Provider meldete einen Fehler trotz Exit-Code 0 und ohne expliziten ' +
        'Ergebnisvertrag; die Abnahme-Gates entscheiden über die Übernahme.'
    }
  }

  const exitDetail = result.exitCode == null ? '' : ` (Exit-Code ${result.exitCode})`
  return {
    status: 'error',
    failureKind: 'worker',
    reason: result.error?.trim() ||
      `Der Provider bewertete den Worker-Abschluss als fehlgeschlagen${exitDetail}.`
  }
}


