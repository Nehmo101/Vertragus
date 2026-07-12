/**
 * Inbox idea → workspace profile transfer types and pure helpers.
 */
import { z } from 'zod'
import type { Idea, IdeaArtifact } from './inbox'
import type { WorkspaceProfile } from './profile'

export const IDEA_TRANSFER_STATUSES = ['pending', 'running', 'planned', 'failed'] as const
export type IdeaTransferStatus = (typeof IDEA_TRANSFER_STATUSES)[number]

export const IDEA_TRANSFER_ACTIONS = [
  'none',
  'needsRepo',
  'needsClone',
  'needsAuth',
  'needsOrchestrator'
] as const
export type IdeaTransferAction = (typeof IDEA_TRANSFER_ACTIONS)[number]

export const ideaTransferSchema = z.object({
  /** Stable per idea; reused across retries. */
  id: z.string().min(1),
  status: z.enum(IDEA_TRANSFER_STATUSES),
  profileId: z.string().min(1),
  error: z.string().optional(),
  retryable: z.boolean().optional(),
  action: z.enum(IDEA_TRANSFER_ACTIONS).optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  planId: z.string().optional()
})

export type IdeaTransfer = z.infer<typeof ideaTransferSchema>

export interface IdeaTransferRequest {
  ideaId: string
  profileId: string
  /** Clone bound GitHub repo when local checkout is missing. */
  clone?: boolean
  yoloMaster?: boolean
}

export interface IdeaTransferResult {
  idea: Idea
  transfer: IdeaTransfer
  /** True when an active transfer already exists (idempotent no-op). */
  duplicate?: boolean
  /** Spawned orchestrator agent id when workspace opened. */
  orchestratorAgentId?: string
}

/** Statuses that block a new transfer/plan attempt (idempotent guard). */
export const BLOCKING_TRANSFER_STATUSES: IdeaTransferStatus[] = ['pending', 'running', 'planned']

/** @deprecated Use BLOCKING_TRANSFER_STATUSES — planned also blocks re-planning in MVP. */
export const ACTIVE_TRANSFER_STATUSES: IdeaTransferStatus[] = ['pending', 'running']

export function isTransferBlocking(transfer: IdeaTransfer | undefined): boolean {
  return transfer ? BLOCKING_TRANSFER_STATUSES.includes(transfer.status) : false
}

export function isTransferActive(transfer: IdeaTransfer | undefined): boolean {
  return transfer ? ACTIVE_TRANSFER_STATUSES.includes(transfer.status) : false
}

export function canStartTransfer(
  transfer: IdeaTransfer | undefined
): { ok: true } | { ok: false; reason: string } {
  if (!transfer) return { ok: true }
  if (transfer.status === 'planned') {
    return {
      ok: false,
      reason: 'Plan wartet im Review — erneutes Planen nur nach Ablehnung oder explizitem Neustart.'
    }
  }
  if (isTransferActive(transfer)) {
    return { ok: false, reason: 'Für diese Idee läuft bereits eine Übergabe oder Planung.' }
  }
  return { ok: true }
}

/** Whether a profile can run review-gated inbox transfer planning. */
export function assessProfileOrchestrator(
  profile: WorkspaceProfile
): { ok: true } | { ok: false; message: string } {
  if (!profile.orchestrator) {
    return {
      ok: false,
      message: 'Profil hat keinen Orchestrator — Übergabe benötigt Planungs-Modus.'
    }
  }
  if (profile.planner.mode === 'manual') {
    return {
      ok: false,
      message: 'Planner-Modus ist „manuell" — execute_plan ist deaktiviert.'
    }
  }
  return { ok: true }
}

function artifactLine(artifact: IdeaArtifact): string {
  if (artifact.kind === 'text') {
    const body = artifact.text?.trim() || '(leer)'
    return `- **${artifact.label}** (Text): ${body.slice(0, 400)}${body.length > 400 ? '…' : ''}`
  }
  if (artifact.kind === 'url') {
    const flag = artifact.urlInvalid ? ' ⚠ ungültige URL' : ''
    return `- **${artifact.label}** (Link): ${artifact.url ?? ''}${flag}`
  }
  const path = artifact.storedPath ?? artifact.sourcePath ?? ''
  const flags = [
    artifact.missing ? 'fehlt' : undefined,
    artifact.copied === false ? 'nur Referenz' : undefined
  ].filter(Boolean)
  const suffix = flags.length > 0 ? ` (${flags.join(', ')})` : ''
  return `- **${artifact.label}** (Datei): ${artifact.fileName ?? path}${suffix}`
}

/** Markdown briefing persisted for the orchestrator and used as execute_plan goal input. */
export function buildIdeaTransferBriefing(idea: Idea, transferId: string): string {
  const tags = idea.tags.length > 0 ? idea.tags.join(', ') : '—'
  const artifactBlock =
    idea.artifacts.length > 0
      ? idea.artifacts.map(artifactLine).join('\n')
      : '_Keine Artefakte._'

  return [
    '# Orca-Strator — Idee-Übergabe',
    '',
    `- **Transfer-ID:** ${transferId}`,
    `- **Idee:** ${idea.title}`,
    `- **Status:** ${idea.status}`,
    `- **Tags:** ${tags}`,
    '',
    '## Zielbeschreibung',
    idea.content.trim() || '_Kein Inhalt — bitte aus Titel und Artefakten ableiten._',
    '',
    '## Artefakte',
    artifactBlock,
    '',
    '## Anweisung an den Orchestrator',
    '1. Rufe `set_goal(title)` mit einem kurzen Zieltitel auf (basierend auf der Idee).',
    '2. Rufe `list_subagents()` auf und plane mit `execute_plan` (version=1, goal, maxParallel, tasks).',
    '3. Jeder Task braucht id, title, role, prompt, dependsOn und conflictKeys.',
    '4. Der Plan läuft im Review-Modus — Subagent-Tasks starten erst nach Freigabe im Orchestrator-Panel.',
    '5. Beginne nicht mit `dispatch_subagent` bevor der Plan freigegeben wurde.'
  ].join('\n')
}

/** Short PTY seed pointing the orchestrator at the persisted briefing file. */
export function buildOrchestratorSeedPrompt(briefingPath: string, ideaTitle: string): string {
  return (
    `Neue Inbox-Idee „${ideaTitle}" wurde übergeben. Lies die Übergabe-Notiz unter "${briefingPath}" ` +
    'und erstelle einen strukturierten Ausführungsplan via execute_plan. Nutze set_goal zuerst. ' +
    'Der Plan wartet auf Review — starte keine dispatch_subagent-Tasks vor Freigabe.'
  )
}
