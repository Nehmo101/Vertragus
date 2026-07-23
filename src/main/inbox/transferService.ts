/**
 * Inbox idea → workspace profile transfer orchestration (main process).
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  buildOrchestratorSeedPrompt,
  canStartTransfer,
  ideaTransferSchema,
  previewIdeaTransferBriefing,
  type IdeaTransfer,
  type IdeaTransferRequest,
  type IdeaTransferResult
} from '@shared/inboxTransfer'
import { profileRepoLocalPath } from '@shared/profile'
import { getIdea, applyIdeaTransfer } from '@main/inbox/store'
import { adoptLegacyDir } from '@main/config/legacyAdoption'
import {
  assessProfileOrchestrator,
  assessRepoReadiness,
  buildNeedsAuthReadiness,
  githubNeedsAuth,
  mapGithubErrorToTransferAction
} from '@main/inbox/transferReadiness'
import { spawnProfileTeam } from '@main/agents/spawnProfile'
import { agentManager } from '@main/agents/AgentManager'
import { workspaceSessions } from '@main/orchestrator/WorkspaceSessionRegistry'
import type { OrchestratorEngine } from '@main/orchestrator/Engine'
import {
  getProfile,
  saveProfile,
  setActiveProfileId
} from '@main/config/store'
import { bindGithubRepo, checkGithubRepoLocal } from '@main/integrations/githubRepo'
import { githubAuthStatus } from '@main/integrations/githubAuth'

const ideaLocks = new Set<string>()
const PLAN_WAIT_MS = 600_000
/** Spawned agent ids per transfer — cleaned up on failure, kept while plan is in review. */
const transferSpawnedAgents = new Map<string, string[]>()

function now(): number {
  return Date.now()
}

function writeBriefing(transferId: string, content: string): string {
  const userData = app.getPath('userData')
  // Bring pre-rebrand transfer briefings along (copy-only, one-time).
  adoptLegacyDir(userData, 'orca-idea-transfers', 'vertragus-idea-transfers')
  const dir = join(userData, 'vertragus-idea-transfers')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `transfer-${transferId}.md`)
  writeFileSync(file, content, 'utf8')
  return file
}

async function seedOrchestrator(agentId: string, prompt: string): Promise<void> {
  await agentManager.seedInteractive(agentId, prompt)
}

function persistTransfer(
  ideaId: string,
  transfer: IdeaTransfer,
  refs?: { profileId?: string; workspaceId?: string; planId?: string }
): IdeaTransferResult['idea'] {
  const idea = getIdea(ideaId)
  if (!idea) throw new Error('Idee nicht gefunden.')
  return applyIdeaTransfer(ideaId, transfer, {
    ...idea.refs,
    profileId: refs?.profileId ?? idea.refs?.profileId,
    workspaceId: refs?.workspaceId ?? idea.refs?.workspaceId,
    planId: refs?.planId ?? idea.refs?.planId
  })
}

function failTransfer(
  ideaId: string,
  transfer: IdeaTransfer,
  message: string,
  retryable: boolean,
  action?: IdeaTransfer['action']
): IdeaTransferResult {
  const failed = ideaTransferSchema.parse({
    ...transfer,
    status: 'failed',
    error: message,
    retryable,
    action: action ?? transfer.action ?? 'none',
    updatedAt: now()
  })
  const idea = persistTransfer(ideaId, failed)
  return { idea, transfer: failed }
}

function trackTransferAgents(transferId: string, agentIds: string[]): void {
  transferSpawnedAgents.set(transferId, agentIds)
}

async function resolveProfileForTransfer(
  profileId: string,
  clone?: boolean
): Promise<{ profile: ReturnType<typeof getProfile>; readiness: ReturnType<typeof assessRepoReadiness> }> {
  const profile = getProfile(profileId)
  if (!profile) throw new Error('Workspace-Profil nicht gefunden.')

  const orch = assessProfileOrchestrator(profile)
  if (!orch.ok) throw new Error(orch.message)

  let workingProfile = profile
  let cloneStatus = profile.githubRepo?.cloneStatus

  if (profile.githubRepo) {
    const localPath = profileRepoLocalPath(profile)
    if (localPath) {
      const check = await checkGithubRepoLocal(
        profile.githubRepo.owner,
        profile.githubRepo.repo,
        localPath
      )
      cloneStatus = check.cloneStatus
    }
  }

  let readiness = assessRepoReadiness(workingProfile, cloneStatus)

  if (!readiness.ready && readiness.action === 'needsClone') {
    const auth = await githubAuthStatus()
    if (githubNeedsAuth(auth)) {
      const scopeHint =
        auth.authenticated && auth.needsReauth
          ? `Fehlende Scopes: ${auth.missingScopes.join(', ')}.`
          : undefined
      return {
        profile: workingProfile,
        readiness: buildNeedsAuthReadiness(
          scopeHint
            ? `GitHub-Scopes unvollständig (${auth.missingScopes.join(', ')}). Bitte erneut anmelden.`
            : 'GitHub-Anmeldung fehlt — bitte zuerst verbinden, bevor das Repository geklont werden kann.'
        )
      }
    }
  }

  if (!readiness.ready && readiness.action === 'needsClone' && clone) {
    const binding = workingProfile.githubRepo!
    const auth = await githubAuthStatus()
    if (githubNeedsAuth(auth)) {
      return {
        profile: workingProfile,
        readiness: buildNeedsAuthReadiness()
      }
    }
    const localPath = readiness.localPath?.trim()
    if (!localPath) {
      throw new Error('Für das Klonen muss ein Zielverzeichnis im Profil gesetzt sein.')
    }
    try {
      const bound = await bindGithubRepo({
        owner: binding.owner,
        repo: binding.repo,
        defaultBranch: binding.defaultBranch,
        localPath,
        clone: true
      })
      workingProfile = {
        ...workingProfile,
        workingDir: bound.workingDir,
        githubRepo: bound.binding
      }
      saveProfile(workingProfile)
      readiness = assessRepoReadiness(workingProfile, bound.binding.cloneStatus)
    } catch (error) {
      const action = mapGithubErrorToTransferAction(error)
      if (action === 'needsAuth') {
        return {
          profile: workingProfile,
          readiness: buildNeedsAuthReadiness(
            error instanceof Error ? error.message : String(error)
          )
        }
      }
      throw error
    }
  }

  return { profile: workingProfile, readiness }
}

function watchForPlanReview(
  ideaId: string,
  transfer: IdeaTransfer,
  engine: OrchestratorEngine,
  timeoutMs = PLAN_WAIT_MS
): void {
  const timeout = setTimeout(() => {
    engine.off('snapshot', onSnapshot)
    failTransfer(
      ideaId,
      transfer,
      'Orchestrator hat keinen Review-Plan innerhalb des Zeitlimits erstellt. Der Workspace bleibt für Diagnose und Fortsetzung erhalten.',
      true
    )
  }, timeoutMs)
  const onSnapshot = (): void => {
    const snap = engine.snapshot()
    if (snap.pendingPlan) {
      clearTimeout(timeout)
      engine.off('snapshot', onSnapshot)
      const planned = ideaTransferSchema.parse({
        ...transfer,
        status: 'planned',
        planId: snap.pendingPlan.planId,
        error: undefined,
        updatedAt: now()
      })
      persistTransfer(ideaId, planned, { planId: snap.pendingPlan.planId })
    }
  }
  engine.on('snapshot', onSnapshot)
  onSnapshot()
}

export async function transferIdeaToProfile(req: IdeaTransferRequest): Promise<IdeaTransferResult> {
  if (ideaLocks.has(req.ideaId)) {
    const idea = getIdea(req.ideaId)
    if (idea?.transfer) {
      return { idea, transfer: idea.transfer, duplicate: true }
    }
    throw new Error('Übergabe wird bereits verarbeitet.')
  }

  const idea = getIdea(req.ideaId)
  if (!idea) throw new Error('Idee nicht gefunden.')

  const guard = canStartTransfer(idea.transfer)
  if (!guard.ok) {
    return {
      idea,
      transfer: idea.transfer!,
      duplicate: true
    }
  }

  ideaLocks.add(req.ideaId)
  const transferId = idea.transfer?.id ?? randomUUID()
  let transfer = ideaTransferSchema.parse({
    id: transferId,
    status: 'pending',
    profileId: req.profileId,
    action: 'none',
    startedAt: idea.transfer?.startedAt ?? now(),
    updatedAt: now()
  })

  try {
    let currentIdea = persistTransfer(req.ideaId, transfer, { profileId: req.profileId })
    const briefing = previewIdeaTransferBriefing(currentIdea, transferId)
    if (!briefing.ok) {
      return failTransfer(req.ideaId, transfer, briefing.message, false)
    }

    const { profile, readiness } = await resolveProfileForTransfer(req.profileId, req.clone)
    if (!profile) throw new Error('Workspace-Profil nicht gefunden.')

    if (!readiness.ready) {
      transfer = ideaTransferSchema.parse({
        ...transfer,
        status: 'failed',
        error: readiness.message,
        retryable: readiness.retryable,
        action: readiness.action,
        updatedAt: now()
      })
      currentIdea = persistTransfer(req.ideaId, transfer)
      return { idea: currentIdea, transfer }
    }

    transfer = ideaTransferSchema.parse({
      ...transfer,
      status: 'running',
      action: 'none',
      error: undefined,
      updatedAt: now()
    })
    currentIdea = persistTransfer(req.ideaId, transfer)

    setActiveProfileId(profile.id)
    const briefingPath = writeBriefing(transferId, briefing.briefing)
    const spawned = await spawnProfileTeam(profile, req.yoloMaster ?? false)
    trackTransferAgents(transferId, spawned.map((agent) => agent.id))

    const orchestrator = spawned.find((a) => a.kind === 'orchestrator')
    if (!orchestrator) {
      return failTransfer(
        req.ideaId,
        transfer,
        'Orchestrator konnte nicht gestartet werden.',
        true
      )
    }

    const session = orchestrator.workspaceSessionId
      ? workspaceSessions.getById(orchestrator.workspaceSessionId)
      : undefined
    const engine = session?.engine
    if (!engine) {
      return failTransfer(
        req.ideaId,
        transfer,
        'Orchestrator-Session konnte nicht aufgelöst werden.',
        true
      )
    }

    transfer = ideaTransferSchema.parse({
      ...transfer,
      workspaceSessionId: session.id,
      updatedAt: now()
    })
    currentIdea = persistTransfer(req.ideaId, transfer, { workspaceId: session.id })
    engine.setGoal(currentIdea.title)
    void seedOrchestrator(
      orchestrator.id,
      buildOrchestratorSeedPrompt(briefingPath, currentIdea.title)
    )
    watchForPlanReview(req.ideaId, transfer, engine)

    return {
      idea: currentIdea,
      transfer,
      orchestratorAgentId: orchestrator.id,
      workspaceSessionId: session.id
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const action = mapGithubErrorToTransferAction(error)
    const retryable = !message.includes('bereits')
    if (action === 'needsAuth') {
      return failTransfer(req.ideaId, transfer, message, true, 'needsAuth')
    }
    return failTransfer(req.ideaId, transfer, message, retryable)
  } finally {
    ideaLocks.delete(req.ideaId)
  }
}

export async function retryIdeaTransfer(ideaId: string, yoloMaster?: boolean): Promise<IdeaTransferResult> {
  const idea = getIdea(ideaId)
  if (!idea?.transfer) throw new Error('Keine fehlgeschlagene Übergabe zum Wiederholen.')
  if (idea.transfer.status !== 'failed') {
    throw new Error('Nur fehlgeschlagene Übergaben können wiederholt werden.')
  }
  if (idea.transfer.retryable === false) {
    throw new Error('Diese Übergabe ist nicht wiederholbar.')
  }
  return transferIdeaToProfile({
    ideaId,
    profileId: idea.transfer.profileId,
    yoloMaster,
    clone: idea.transfer.action === 'needsClone' || idea.transfer.action === 'needsAuth'
  })
}

/** Test hook: clear in-memory transfer locks and diagnostics tracking. */
export function __clearTransferLocksForTest(): void {
  ideaLocks.clear()
  transferSpawnedAgents.clear()
}
