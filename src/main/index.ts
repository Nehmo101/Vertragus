import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, nativeImage, safeStorage, ipcMain, shell } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { mainMessages, readLocale } from '@shared/mainMessages'
import { allRoleTemplates, roleColor } from '@shared/prompts/roles'
import { PtyAgent } from './agents/PtyAgent'
import { resolveLaunch } from './agents/resolveCommand'
import {
  agentCurrentTaskFields,
  APP_CHANNELS,
  capTimelineEvents,
  createStubWorkspaceDirectory,
  PANEL_TASKS_MAX,
  registerAppIpc,
  toPanelSettings,
  type WorkspaceDirectory,
  type WorkspaceSummary
} from './appIpc'
import { createAppVoice, installDefaultVoicePermissions, type AppVoice } from './appVoice'
import { createAppWorkspaceManager, maybeStartDevWorkspace, type DevRunHandle } from './devRun'
import {
  getAgentRegistry,
  registerTerminalIpc,
  setTerminalImageSaver,
  setTerminalInputSink,
  setTerminalSessionActions,
  setTerminalQuestionSource
} from './ipc'
import { cliChromeForWorkspace, workspaceOwningAgent } from './workspace/cliSessionFeed'
import { cliQuestionContext } from './terminalQuestion'
import {
  assertImageBytes,
  bytesFromAbsPath,
  bytesFromClipboard,
  coerceBytes,
  localizedAttachmentError,
  writeAttachment
} from './attachments'
import { startMcpServer, type McpServerHandle } from './mcp/server'
import {
  getProfile,
  getProfiles,
  getRoleTemplates,
  getSettings,
  setSetting,
  settings
} from './store/settings'
import {
  closeCliWindow,
  createCliWindow,
  focusCliWindow,
  getCliWindow,
  layoutCliWindows,
  applyCliWindowZones,
  onCliWindowClosed,
  workspaceUsesTabChrome
} from './windows/cliWindow'
import { cliFocusTargets, focusWorkspaceAgents } from './windows/focusWorkspace'
import { focusTimelineWindow } from './windows/timelineWindow'
import {
  forgetHideAll,
  hideAllHotkeyStatus,
  registerAppHideAllShortcut,
  toggleHideAll,
  unregisterHideAllShortcut
} from './windows/hideAll'
import { suppressMoveTracking } from './windows/placement'
import { createPanelWindow, getPanelWindow, isPanelWindowSender } from './windows/panel'
import { armPanelAttention, attentionOverlayPng } from './windows/panelAttention'
import { armProfileEditorSmoke, openProfileEditorWindow } from './windows/profileEditor'
import { armProviderEditorSmoke } from './windows/providerEditor'
import {
  armSettingsWindowSmoke,
  isSettingsWindowSender,
  listSettingsWindows,
  openSettingsWindow
} from './windows/settingsWindow'
import { createRemoteController, type RemoteController } from './remote/controller'
import { registerRemoteIpc } from './remote/ipc'
import { bindOptions } from './remote/interfaces'
import { createPairingTokenFile } from './remote/tokenFile'
import { registerBrowserExtensionIpc } from './browserExtension/ipc'
import { resolveChromiumExtensionDir } from './browserExtension/path'
import { installChromiumExtension } from './browserExtension/install'
import { orderByParent } from './workspace/orderByParent'
import { resolveUserMessageTarget } from './workspace/userMessageTarget'
import { armWindowCapture } from './windows/smokeCapture'
import { armZoneOverlaySmoke } from './windows/zoneOverlay'
import { startAppUpdater } from './updater'
import type { WorkspaceManager } from './workspace/WorkspaceManager'
import { runDir } from './workspace/journal'
import {
  boardForResume,
  buildResumeBriefing,
  latestRun,
  markSuccessionConsumed,
  readRunEvents,
  readRunTasks,
  readSuccessionPackage,
  successionSuperseded
} from './workspace/resume'
import { revealRunFolder } from './workspace/revealRunFolder'
import { taskWindow } from './workspace/taskWindow'
import { createWorktreeCleanup } from './workspace/worktreeCleanup'
import { applyIsolatedUserData } from './isolatedUserData'

// Before whenReady: electron-store binds userData on first settings read.
applyIsolatedUserData()

/**
 * Headless smoke hook: <envVar>=<path> boots the window, captures it and exits.
 * Used by the panel smoke script and for owner verification of the glass
 * rendering (panel: VERTRAGUS_PANEL_SCREENSHOT, CLI: VERTRAGUS_CLI_SCREENSHOT).
 * The capture mechanics (show, wait for paint, retry) live in smokeCapture.
 */
function armScreenshotHook(win: Electron.BrowserWindow, envVar: string, delayMs = 1_500): void {
  armWindowCapture(win, envVar, envVar, delayMs)
}

function worktreePathForAgent(manager: WorkspaceManager, agentId: string): string | undefined {
  for (const workspace of manager.list()) {
    const path = workspace.worktreePathOf(agentId)
    if (path) return path
  }
  return undefined
}

async function bytesFromTerminalSource(
  source: 'clipboard' | { absPath: string } | { bytes: Uint8Array; mime?: string }
): Promise<Uint8Array | null> {
  if (source === 'clipboard') return bytesFromClipboard(clipboard.readImage())
  if ('absPath' in source) return bytesFromAbsPath(source.absPath)
  const bytes = coerceBytes(source.bytes)
  if (!bytes) return null
  assertImageBytes(bytes)
  return bytes
}

/** Adapter: WorkspaceManager → the view the panel draws. */
function panelDirectory(manager: WorkspaceManager, mcp: McpServerHandle): WorkspaceDirectory {
  const roleLabel = (roleId: string): string =>
    allRoleTemplates(getRoleTemplates()).find((role) => role.id === roleId)?.name ?? roleId

  const pendingOf = (workspaceId: string, agentId: string) => mcp.openQuestion(workspaceId, agentId)

  const pendingFields = (open: ReturnType<McpServerHandle['openQuestion']>) =>
    open
      ? {
          pendingQuestion: open.question,
          pendingQuestionId: open.questionId,
          ...(open.choices && open.choices.length > 0
            ? { pendingQuestionChoices: open.choices }
            : {})
        }
      : {}

  // Active paths across ALL workspaces, not just the asking profile's: two
  // profiles may point at the same repository, and an agent of either must
  // never show up as removable.
  const cleanup = createWorktreeCleanup({
    repoPathFor: (profileId) => getProfile(profileId)?.repoPath,
    activeWorktreePaths: () =>
      manager.list().flatMap((workspace) => workspace.activeWorktreePaths()),
    locale: () => readLocale(() => getSettings().ui.locale)
  })

  const windowOpenOf = (agentId: string): boolean => getCliWindow(agentId) !== null

  return {
    list: () =>
      manager.list().map<WorkspaceSummary>((ws) => {
        const orchestrator = ws.orchestrator
        const roleIds = [...new Set(ws.profile.slots.map((slot) => slot.roleId))]
        const orchestratorQuestion = orchestrator
          ? pendingOf(ws.workspaceId, orchestrator.agentId)
          : undefined
        // S4: the plan, already tombstone-free and readiness-resolved by the
        // host. Capped here because this payload is re-broadcast on every
        // change and also travels to the phone — but the counts come from the
        // whole board, and the window keeps unfinished work over finished
        // (see workspace/taskWindow).
        const plan = taskWindow(ws.listTasks(), PANEL_TASKS_MAX)
        return {
          workspaceId: ws.workspaceId,
          name: ws.name,
          profileId: ws.profileId,
          profileName: ws.profile.name,
          // Not "was an orchestrator ever started" — a crashed orchestrator
          // must grey the card out even though its record (and window) stay.
          active: ws.orchestratorAlive,
          ...(ws.goalText ? { goalText: ws.goalText } : {}),
          ...(ws.compiledPreview ? { compiledPreview: ws.compiledPreview } : {}),
          ...(ws.orchestratorIdle ? { orchestratorIdle: true } : {}),
          // C6: a successor is spawning — the seat is mid-cutover, which is
          // neither "working" nor the greyed-out dead state.
          ...(ws.successionInProgress() ? { successionInProgress: true as const } : {}),
          // D3: the orchestrator's open ask_user question, registry-keyed
          // under the reserved agent id 'user'.
          ...(() => {
            const open = mcp.openQuestion(ws.workspaceId, 'user')
            return open ? { userQuestion: open } : {}
          })(),
          ...(plan.total > 0
            ? { tasks: plan.rows, taskTotal: plan.total, taskDone: plan.done }
            : {}),
          // A3: the run's pull request. Only the three fields the card reads —
          // the branch pair lives in the event and the journal, not on a chip.
          ...(() => {
            const pr = ws.runPullRequest
            if (!pr) return {}
            return {
              pullRequest: {
                ok: pr.ok,
                ...(pr.url ? { url: pr.url } : {}),
                ...(pr.message ? { message: pr.message } : {})
              }
            }
          })(),
          agents: [
            ...(orchestrator
              ? [
                  {
                    agentId: orchestrator.agentId,
                    name: orchestrator.name,
                    roleId: 'orchestrator',
                    roleLabel: 'Orchestrator',
                    roleColor: roleColor('orchestrator'),
                    state: ws.orchestratorAlive ? ('working' as const) : ('stopped' as const),
                    // Latest user CLI submit — not the last delegated start_agent.
                    ...agentCurrentTaskFields(ws.orchestratorTaskText),
                    ...(windowOpenOf(orchestrator.agentId) ? { windowOpen: true } : {}),
                    ...pendingFields(orchestratorQuestion)
                  }
                ]
              : []),
            // F: flat list with indentation — every agent right after its
            // lead. Root children keep start order; orphans (unknown parent)
            // fall back to the end rather than disappearing.
            ...orderByParent(ws.listAgents(), (agent) =>
              mcp.agentParent(ws.workspaceId, agent.agentId)
            ).map((agent) => {
              const pendingQuestion = pendingOf(ws.workspaceId, agent.agentId)
              const agentTask = mcp.agentTask(ws.workspaceId, agent.agentId)
              const parentId = mcp.agentParent(ws.workspaceId, agent.agentId)
              return {
                agentId: agent.agentId,
                name: agent.name,
                roleId: agent.role,
                roleLabel: agent.kind === 'lead' ? 'Lead' : roleLabel(agent.role),
                roleColor: roleColor(agent.role, roleIds.indexOf(agent.role)),
                state:
                  agent.status === 'working'
                    ? ('working' as const)
                    : agent.status === 'starting'
                      ? ('waiting' as const)
                      : ('stopped' as const),
                ...(agent.kind ? { kind: agent.kind } : {}),
                ...(parentId ? { parentId } : {}),
                ...agentCurrentTaskFields(agentTask),
                ...(windowOpenOf(agent.agentId) ? { windowOpen: true } : {}),
                ...pendingFields(pendingQuestion)
              }
            })
          ]
        }
      }),
    async start(profileId, goal, attachmentIds) {
      const profile = getProfile(profileId)
      const locale = readLocale(() => getSettings().ui.locale)
      if (!profile) {
        throw new Error(mainMessages(locale).unknownProfile(profileId))
      }
      try {
        return await manager.startWorkspace(profile, {
          ...(goal ? { goal } : {}),
          ...(attachmentIds?.length ? { attachmentIds } : {})
        })
      } catch (error) {
        throw localizedAttachmentError(error, locale)
      }
    },
    worktreePathOf(workspaceId, agentId) {
      return manager.worktreePathOf(workspaceId, agentId)
    },
    async assignGoal(workspaceId, goal) {
      try {
        await manager.assignGoal(workspaceId, goal)
      } catch (error) {
        // The host code is the workspace's contract, not a sentence for a
        // human who just typed into the goal field.
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('goal_already_set')) {
          const messages = mainMessages(readLocale(() => getSettings().ui.locale))
          throw new Error(messages.goalAlreadySet)
        }
        throw error
      }
    },
    async resume(profileId) {
      const profile = getProfile(profileId)
      if (!profile) {
        const locale = readLocale(() => getSettings().ui.locale)
        throw new Error(mainMessages(locale).unknownProfile(profileId))
      }
      // E3: brief a NEW orchestrator on the newest journaled run. The old
      // run's goal (when its meta recorded one) is re-seeded over the same
      // handshake, so the card and the orchestrator agree on what continues.
      const run = await latestRun(profile.repoPath, profile.id)
      if (!run) {
        const locale = readLocale(() => getSettings().ui.locale)
        throw new Error(mainMessages(locale).resumeNoRun(profile.repoPath))
      }
      // S4 (fail-soft): the old run's task board — dead owners freed — seeds
      // the new board and gets one honest mention in the briefing.
      const rawTasks = await readRunTasks(profile.repoPath, run.workspaceId)
      const tasks = rawTasks ? boardForResume(rawTasks) : undefined
      // C6: that run may have died mid-handoff. Its frozen package briefs the
      // new orchestrator instead of the journal summary — and is only retired
      // once the start actually succeeded, so a failed boot can try again.
      //
      // Unless the journal contradicts it. Both renames that retire a package
      // are best-effort, so a surviving `succession.json` is a hint, not a
      // fact; the journal is the fact, and it is already loaded. A package the
      // run outlived would seed a fresh orchestrator with a stale roster while
      // asserting the run died at the freeze — and would drop the briefing
      // that covers everything since.
      const frozen = await readSuccessionPackage(profile.repoPath, run.workspaceId)
      const stale = frozen !== undefined && successionSuperseded(frozen, run.events)
      if (stale) await markSuccessionConsumed(profile.repoPath, run.workspaceId, {}, 'failed')
      const succession = stale ? undefined : frozen
      const running = await manager.startWorkspace(profile, {
        resume: {
          briefing: buildResumeBriefing(run, tasks),
          fromWorkspaceId: run.workspaceId,
          ...(tasks ? { tasks } : {}),
          ...(succession ? { succession } : {})
        },
        ...(run.meta?.goal ? { goal: run.meta.goal } : {})
      })
      if (succession) await markSuccessionConsumed(profile.repoPath, run.workspaceId)
      return running
    },
    stop: (workspaceId) => manager.stopWorkspace(workspaceId),
    // Panel-only, spoken: type a follow-up into the running orchestrator. The
    // refusals stay host codes like the neighbouring members — the voice layer
    // is what turns them into something spoken.
    sendToOrchestrator(workspaceId, text) {
      const workspace = manager.get(workspaceId)
      if (!workspace) {
        throw new Error(`send to orchestrator rejected — unknown workspace ${workspaceId}`)
      }
      const orchestrator = workspace.orchestrator
      if (!orchestrator) {
        throw new Error(mainMessages(readLocale(() => getSettings().ui.locale)).noOrchestrator)
      }
      return workspace.sendToAgent(orchestrator.agentId, text)
    },
    async succeedOrchestrator(workspaceId) {
      const workspace = manager.get(workspaceId)
      if (!workspace) {
        throw new Error(`orchestrator replacement rejected — unknown workspace ${workspaceId}`)
      }
      try {
        await workspace.replaceOrchestratorFromHost()
      } catch (error) {
        // The host codes are the MCP contract's, not a sentence for a human
        // who just pressed a button.
        const message = error instanceof Error ? error.message : String(error)
        const messages = mainMessages(readLocale(() => getSettings().ui.locale))
        if (message.includes('already_in_progress')) {
          throw new Error(messages.successorAlreadyStarting)
        }
        if (message.includes('no_orchestrator')) {
          throw new Error(messages.noOrchestrator)
        }
        throw error
      }
    },
    postUserMessage(workspaceId, text, targetAgentId) {
      const workspace = manager.get(workspaceId)
      if (!workspace) throw new Error(`user message rejected — unknown workspace ${workspaceId}`)
      const target = resolveUserMessageTarget(
        targetAgentId,
        (id) => {
          if (workspace.orchestrator?.agentId === id) return { name: workspace.orchestrator.name }
          const agent = workspace.listAgents().find((row) => row.agentId === id)
          return agent ? { name: agent.name } : undefined
        },
        (id) => mcp.agentParent(workspaceId, id),
        workspace.orchestrator?.agentId
      )
      workspace.postUserMessage(text, target)
    },
    async promoteAgentBranch(workspaceId, agentId) {
      const workspace = manager.get(workspaceId)
      if (!workspace) throw new Error(`promote rejected — unknown workspace ${workspaceId}`)
      const outcome = await workspace.promoteAgentBranch(agentId)
      if (!outcome.ok) {
        const locale = readLocale(() => getSettings().ui.locale)
        throw new Error(
          mainMessages(locale).promoteConflict(
            outcome.conflictFiles.join(', ') || mainMessages(locale).unknownConflictFiles
          )
        )
      }
    },
    async openRunFolder(workspaceId) {
      const workspace = manager.get(workspaceId)
      if (!workspace) throw new Error(`run folder rejected — unknown workspace ${workspaceId}`)
      // The openPath contract (resolves with an error STRING, never rejects)
      // is a rule with two branches, so it lives in a module a test can hold.
      await revealRunFolder(
        (path) => shell.openPath(path),
        runDir(workspace.repoPath, workspaceId),
        readLocale(() => getSettings().ui.locale)
      )
    },
    async answerQuestion(workspaceId, agentId, questionId, text) {
      // One host path (H1): identical to the orchestrator's
      // send_to_agent{questionId} — see mcp/answerQuestion.ts.
      const outcome = await mcp.answerQuestion(workspaceId, agentId, questionId, text)
      if (outcome.ok) return
      const messages = mainMessages(readLocale(() => getSettings().ui.locale))
      switch (outcome.error) {
        case 'unknown_workspace':
          // Raw like the other unknown-id refusals in this directory: only a
          // renderer that lost track of a closed workspace can reach it.
          throw new Error(`answer rejected — unknown workspace ${workspaceId}`)
        // The remaining three are races an ordinary click loses: the question
        // was answered elsewhere, or the agent died between render and send.
        case 'unknown_question':
          throw new Error(messages.answerQuestionClosed)
        case 'question_agent_mismatch':
          throw new Error(messages.answerAgentMismatch)
        case 'answer_delivery_failed':
          throw new Error(messages.answerNotDelivered(outcome.message))
      }
    },
    focusAgent(agentId) {
      if (getCliWindow(agentId)) {
        focusCliWindow(agentId)
        return
      }
      // A closed window of a still-registered agent (finished, scrollback
      // intact) reopens so the last task is not a tooltip-only memory.
      if (!getAgentRegistry().getAgent(agentId)) return
      for (const workspace of manager.list()) {
        if (workspace.showAgentWindow(agentId)) {
          // Cancel startMinimized on this first-show: the click asked to see it.
          focusCliWindow(agentId)
          return
        }
      }
    },
    closeAgentWindow: (agentId) => closeCliWindow(agentId),
    applyProfileZones(profileId, zones) {
      for (const workspace of manager.listForProfile(profileId)) {
        workspace.applyZoneLayout(zones)
        applyCliWindowZones(workspace.workspaceId, zones)
      }
    },
    focusWorkspace(workspaceId) {
      const workspace = manager.get(workspaceId)
      if (!workspace) return
      // Orchestrator first (stable focus target), then subagents in start order.
      const agentIds = [
        ...(workspace.orchestrator ? [workspace.orchestrator.agentId] : []),
        ...workspace.listAgents().map((agent) => agent.agentId)
      ]
      // Workspace click replaced hide-all's snapshot: forget it so the next
      // toggle hides what is visible instead of restoring foreign windows.
      forgetHideAll()
      if (agentIds.length > 0) {
        let startMinimized = false
        try {
          startMinimized = getSettings().ui.startMinimized === true
        } catch {
          startMinimized = false
        }
        focusWorkspaceAgents(agentIds, {
          windows: cliFocusTargets,
          beforeHide: suppressMoveTracking,
          beforeRestore: suppressMoveTracking,
          beforeShow: suppressMoveTracking,
          restoreMinimized: !startMinimized
        })
        // After show: restore can fire move events that wreck bounds (Windows).
        // Tabs do not tile; startMinimized must not snap still-minimized teammates.
        if (!startMinimized && !workspaceUsesTabChrome(workspaceId)) {
          layoutCliWindows(agentIds)
        }
      }
    },
    openTimeline(workspaceId) {
      const workspace = manager.get(workspaceId)
      if (!workspace) return
      focusTimelineWindow(workspaceId)
    },
    async readTimelineEvents(workspaceId) {
      const workspace = manager.get(workspaceId)
      if (!workspace) return []
      const events = (await readRunEvents(workspace.repoPath, workspaceId)) ?? []
      return capTimelineEvents(events)
    },
    onTimelineEvent(workspaceId, listener) {
      return manager.onTimelineEvent(workspaceId, listener)
    },
    listStaleWorktrees: (profileId) => cleanup.listStale(profileId),
    removeWorktree: (profileId, worktreePath) => cleanup.remove(profileId, worktreePath),
    // The push channel: appIpc turns this into ev:workspaces, which is what
    // lets the panel drop its poll — badges and card states update the moment
    // something happens instead of up to four seconds later. Window close is
    // the same feed: dismissing a finished agent must drop its ✕ immediately.
    onChange: (listener) => {
      const offManager = manager.onChange(listener)
      const offWindows = onCliWindowClosed(() => listener())
      return () => {
        offManager()
        offWindows()
      }
    }
  }
}

/**
 * Feed every agent's current task note and host session snapshot into the
 * terminal registry, so the CLI window's hover card and session chrome follow
 * the same change feed as the panel. `setAgentTask` / `setAgentSession` /
 * `refreshQuestions` dedupe, so a burst of unrelated events costs nothing
 * and never focuses a CLI window.
 */
function armTerminalChromeFeed(manager: WorkspaceManager, mcp: McpServerHandle): void {
  const registry = getAgentRegistry()
  const push = (): void => {
    for (const ws of manager.list()) {
      for (const row of cliChromeForWorkspace(ws, mcp)) {
        registry.setAgentTask(row.agentId, row.task)
        registry.setAgentSession(row.agentId, row.session)
      }
    }
    registry.refreshQuestions()
  }
  manager.onChange(push)
}

// --- M1 dev verification path -------------------------------------------
// VERTRAGUS_DEV_SPAWN=<command line> spawns one real PTY agent after ready and
// opens its CLI window — kept as the CLI-window screenshot smoke.
async function startDevAgent(): Promise<void> {
  const commandLine = process.env.VERTRAGUS_DEV_SPAWN?.trim()
  if (!commandLine) return

  const [command, ...rawArgs] = commandLine.split(/\s+/)
  if (!command) return

  const agentId = 'dev-agent'
  const agent = new PtyAgent()
  const registry = registerTerminalIpc()
  try {
    const launch = await resolveLaunch(command, rawArgs)
    agent.spawn({ file: launch.file, args: launch.args, cwd: homedir() })
  } catch (error) {
    // Raw English on purpose: this whole path exists only behind
    // VERTRAGUS_DEV_SPAWN and is read by whoever set that variable.
    agent.push(`\x1b[31mspawn failed: ${String(error)}\x1b[0m\r\n`)
  }
  registry.registerAgent({
    pty: agent,
    meta: {
      agentId,
      name: 'Caronte',
      role: 'worker',
      roleColor: '#2f7d6d',
      provider: 'dev',
      model: ''
    }
  })
  const win = createCliWindow(agentId, { title: 'Caronte', roleColor: '#2f7d6d' })
  armScreenshotHook(win, 'VERTRAGUS_CLI_SCREENSHOT', 3_000)
}
// --- end M1 dev verification path ---------------------------------------

let appMcp: McpServerHandle | undefined
let appManager: WorkspaceManager | undefined
let disposePanelAttention: (() => void) | undefined
let devRun: DevRunHandle | undefined
let appVoice: AppVoice | undefined

function sendToPanel(channel: string, payload: unknown): void {
  const win = getPanelWindow()
  if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
}

/** Windows taskbar overlay for open questions; null if the image cannot be built. */
function panelAttentionOverlay(): { image: Electron.NativeImage; description: () => string } | null {
  try {
    const image = nativeImage.createFromBuffer(attentionOverlayPng())
    if (image.isEmpty()) return null
    return {
      image,
      description: () =>
        mainMessages(readLocale(() => getSettings().ui.locale)).panelAttentionOverlay
    }
  } catch {
    return null
  }
}

function broadcastPanelSettings(): void {
  const value = toPanelSettings(getSettings(), hideAllHotkeyStatus(), app.isPackaged)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.isDestroyed()) continue
    win.webContents.send(APP_CHANNELS.eventSettings, value)
    win.webContents.send(APP_CHANNELS.eventAppearance, value.appearance)
  }
}

function attachVoice(directory: WorkspaceDirectory): AppVoice {
  const voice = createAppVoice({
    directory,
    store: () => settings(),
    hideAll: () => toggleHideAll(),
    openSettings: () => openSettingsWindow(),
    openProfileEditor: (profileId) => openProfileEditorWindow(profileId),
    quit: () => app.quit(),
    onYoloChanged: () => broadcastPanelSettings(),
    sendToPanel
  })
  appVoice = voice
  return voice
}
let remote: RemoteController | undefined

/** The built web client sits next to the main bundle: out/main → out/remote. */
function remoteStaticRoot(): string {
  return join(__dirname, '..', 'remote')
}

/**
 * Wire the remote-access controller to the app: the command gateway delegates
 * to the same WorkspaceDirectory the panel uses, terminals come from the shared
 * registry, and workspace changes fan out over the same manager feed.
 *
 * The pairing token is encrypted at rest with Electron safeStorage when the
 * OS keychain is available, and always also written to a 0600 file under
 * userData so the Tailscale QR survives a restart without a keyring.
 */
function buildRemoteController(
  directory: WorkspaceDirectory,
  manager: WorkspaceManager
): RemoteController {
  return createRemoteController({
    readSettings: () => getSettings().remote,
    writeSettings: (next) => setSetting('remote', next),
    locale: () => readLocale(() => getSettings().ui.locale),
    networkInterfaces: () => networkInterfaces() as Parameters<typeof bindOptions>[0],
    secrets: {
      // No OS keychain (a Linux desktop without a configured keyring) → do
      // not write the token into electron-store JSON. The 0600 fallback file
      // is what keeps the pairing URL stable across restarts in that case.
      available: safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (cipher) => {
        try {
          return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
        } catch {
          return undefined
        }
      }
    },
    tokenFallback: createPairingTokenFile(join(app.getPath('userData'), 'remote-pairing.token')),
    staticRoot: remoteStaticRoot(),
    serverBase: {
      gateway: {
        listWorkspaces: () => directory.list(),
        listProfiles: () =>
          getProfiles().map((profile) => ({
            id: profile.id,
            name: profile.name,
            repoPath: profile.repoPath
          })),
        startWorkspace: (profileId, goal) => directory.start(profileId, goal),
        stopWorkspace: (workspaceId) => directory.stop(workspaceId),
        answerQuestion: ({ workspaceId, agentId, questionId, text }) =>
          directory.answerQuestion(workspaceId, agentId, questionId, text),
        userMessage: ({ workspaceId, text, targetAgentId }) =>
          directory.postUserMessage(workspaceId, text, targetAgentId),
        assignGoal: ({ workspaceId, goal }) => directory.assignGoal(workspaceId, goal)
      },
      terminals: () => getAgentRegistry().terminals(),
      onWorkspaceChange: (listener) => manager.onChange(listener),
      locale: () => getSettings().ui.locale,
      theme: () => getSettings().ui.theme
    }
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('org.nehmo.vertragus')

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerTerminalIpc()

  // One MCP server + one WorkspaceManager serve both the panel's play button
  // and the dev run; the dev run merely injects them instead of starting its
  // own pair.
  //
  // This is the ONLY registerAppIpc call in the app: the first call binds the
  // workspace directory for good (see the guard there), so a second one
  // anywhere else would silently decide that the panel talks to the refusing
  // stub instead of the real manager.
  try {
    let emitBrowserExtension = (): void => undefined
    appMcp = await startMcpServer({
      browserToken: getSettings().browserExtensionToken,
      onBrowserToken: (token) => {
        try {
          setSetting('browserExtensionToken', token)
        } catch {
          /* fail-soft: a store hiccup must not take down the MCP listener */
        }
      },
      onBrowserChange: () => emitBrowserExtension()
    })
    appManager = createAppWorkspaceManager(appMcp)
    const directory = panelDirectory(appManager, appMcp)
    registerAppIpc(directory, undefined, attachVoice(directory).port)
    armTerminalChromeFeed(appManager, appMcp)
    // Native taskbar/dock blink for open questions. Driven by the same
    // onMutate → onChange feed that refreshes panel badges. flashFrame is
    // the unfocused path; the overlay toggles so the icon still blinks
    // while the panel already has focus (Windows flashFrame is a no-op then).
    disposePanelAttention = armPanelAttention({
      window: getPanelWindow,
      dock: () => app.dock ?? null,
      overlay: panelAttentionOverlay(),
      openCount: () => appMcp?.openQuestionCount() ?? 0,
      onChange: (listener) => appManager?.onChange(listener) ?? (() => undefined)
    })
    // Late-bound: registerTerminalIpc ran before the manager existed. ipc.ts
    // must not import WorkspaceManager. Seed / sendToAgent / assignGoal paste
    // go through pty.write and never hit this sink.
    const manager = appManager
    setTerminalInputSink((agentId, data) => {
      manager.noteOrchestratorGoal(agentId, data)
    })
    setTerminalQuestionSource({
      contextFor: (senderAgentId) => cliQuestionContext(senderAgentId, directory.list()),
      answer: (workspaceId, agentId, questionId, text) =>
        directory.answerQuestion(workspaceId, agentId, questionId, text)
    })
    setTerminalSessionActions({
      followUp: async (agentId, text) => {
        const ws = workspaceOwningAgent(manager.list(), agentId)
        if (!ws) throw new Error(`follow-up rejected — unknown agent ${agentId}`)
        const target = ws.orchestrator?.agentId === agentId ? undefined : agentId
        directory.postUserMessage(ws.workspaceId, text, target)
      },
      answer: async (agentId, questionId, text) => {
        const ws = workspaceOwningAgent(manager.list(), agentId)
        if (!ws) throw new Error(`answer rejected — unknown agent ${agentId}`)
        const mcp = appMcp
        if (!mcp) throw new Error('answer rejected — MCP is not running')
        const userQuestion = mcp.openQuestion(ws.workspaceId, 'user')
        const target = userQuestion?.questionId === questionId ? 'user' : agentId
        await directory.answerQuestion(ws.workspaceId, target, questionId, text)
      }
    })
    setTerminalImageSaver(async (agentId, source) => {
      const locale = readLocale(() => getSettings().ui.locale)
      try {
        const bytes = await bytesFromTerminalSource(source)
        if (!bytes) return null
        const cwd = worktreePathForAgent(manager, agentId)
        if (!cwd) throw localizedAttachmentError(new Error('attachment_worktree_missing'), locale)
        return await writeAttachment(cwd, bytes)
      } catch (error) {
        throw localizedAttachmentError(error, locale)
      }
    })
    const broadcastSettings = (channel: string, payload: unknown): void => {
      for (const { window } of listSettingsWindows()) {
        if (!window.isDestroyed()) window.webContents.send(channel, payload)
      }
    }
    // Remote access — off by default. The controller does nothing until the
    // user enables it in settings; wiring it here gives the settings channels
    // a live controller to drive.
    remote = buildRemoteController(directory, appManager)
    const remoteIpc = registerRemoteIpc({
      ipcMain: ipcMain as unknown as Parameters<typeof registerRemoteIpc>[0]['ipcMain'],
      controller: remote,
      bindOptions: () => bindOptions(networkInterfaces() as Parameters<typeof bindOptions>[0]),
      isSettingsSender: (id) => isSettingsWindowSender(id),
      broadcast: broadcastSettings
    })
    const browserIpc = registerBrowserExtensionIpc({
      ipcMain: ipcMain as unknown as Parameters<typeof registerBrowserExtensionIpc>[0]['ipcMain'],
      bridge: () => appMcp?.browser,
      extensionPath: () =>
        resolveChromiumExtensionDir({
          resourcesPath: process.resourcesPath,
          candidates: [
            join(app.getAppPath(), 'extensions/chromium'),
            join(app.getAppPath(), '../../extensions/chromium'),
            join(process.cwd(), 'extensions/chromium')
          ]
        }),
      reveal: (path) => shell.openPath(path),
      install: (extensionDir) =>
        installChromiumExtension({
          extensionDir,
          reveal: (path) => shell.openPath(path)
        }),
      isSettingsSender: (id) => isSettingsWindowSender(id),
      broadcast: broadcastSettings
    })
    emitBrowserExtension = () => browserIpc.emit()
    // Resume a server the user had enabled before the last quit.
    if (getSettings().remote.enabled) {
      await remote.apply({ enabled: true })
      remoteIpc.emit()
    }
  } catch (error) {
    console.error('[boot] MCP server did not start — panel runs without workspaces:', error)
    // A console the user cannot open is not a report. The reason travels into
    // the stub directory, so the next Play/Resume answers with what actually
    // failed instead of "not wired up yet" — which reads as an unfinished
    // feature and sends nobody looking for a broken MCP boot.
    registerAppIpc(
      undefined,
      error instanceof Error ? error.message : String(error),
      attachVoice(createStubWorkspaceDirectory()).port
    )
  }

  // Mic capture is a panel-window permission; device labels also need it in settings.
  installDefaultVoicePermissions((id) => isPanelWindowSender(id) || isSettingsWindowSender(id))

  // Hide-all: the global hotkey. A failed registration is not fatal — the
  // status reaches the panel through settings:get, and the eye still works.
  const hotkey = registerAppHideAllShortcut()
  if (!hotkey.registered) console.warn('[boot] hide-all hotkey:', hotkey.error)

  // Self-update: checks once now and every six hours after that. Inert in a dev
  // run, so this line is a no-op for everyone except an installed Vertragus.
  // It runs AFTER registerAppIpc, so the first state push has a listener.
  startAppUpdater()

  // Env-gated verification hooks; no-ops in every normal run. All of them live
  // here, next to each other — a window smoke hook hidden inside an IPC
  // registration is how you end up calling that registration twice.
  armScreenshotHook(createPanelWindow(), 'VERTRAGUS_PANEL_SCREENSHOT')

  // After the panel exists so a stored-on session can ask for the mic.
  if (getSettings().voice.enabled) void appVoice?.port.setEnabled(true)
  armProfileEditorSmoke()
  armProviderEditorSmoke()
  armSettingsWindowSmoke()
  armZoneOverlaySmoke()
  void startDevAgent()
  if (appMcp && appManager) {
    const mcp = appMcp
    const manager = appManager
    devRun = await maybeStartDevWorkspace({
      startServer: async () => mcp,
      createManager: () => manager
    })
    // Owner verification of the real orchestrator boot: capture its CLI
    // window (real claude with MCP attach) and exit.
    if (devRun && process.env.VERTRAGUS_DEV_RUN_SCREENSHOT) {
      const { getCliWindow } = await import('./windows/cliWindow')
      const win = getCliWindow(devRun.workspace.orchestrator?.agentId ?? '')
      if (win) armScreenshotHook(win, 'VERTRAGUS_DEV_RUN_SCREENSHOT', 12_000)
    }
  }

  // Also the way back from the panel's − : createPanelWindow restores and
  // focuses the existing window, so activating the app un-minimizes it.
  app.on('activate', () => {
    createPanelWindow()
  })
})

app.on('will-quit', () => {
  // A leaked global shortcut outlives the process on Windows.
  unregisterHideAllShortcut()
  disposePanelAttention?.()
  disposePanelAttention = undefined
})

/**
 * Ceiling for the quit-time shutdown. Covers the POSIX SIGTERM→SIGKILL grace
 * (5 s) plus taskkill latency; a wedged kill must not wedge quitting forever.
 */
const QUIT_SHUTDOWN_CEILING_MS = 8_000

let quitting = false

app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  // Electron would exit before the fire-and-forget kills land, orphaning
  // yolo-mode CLI processes. Hold the quit, await the kills (bounded), then
  // exit for real — the second pass falls through the `quitting` guard.
  event.preventDefault()
  const shutdown = (async () => {
    // devRun shares the app's manager/server, so stopping twice must be safe.
    appVoice?.dispose()
    appVoice = undefined
    await remote?.stop().catch(() => undefined)
    await devRun?.stop().catch(() => undefined)
    await appManager?.stopAll({ awaitExitMs: QUIT_SHUTDOWN_CEILING_MS - 1_000 }).catch(() => undefined)
    await appMcp?.close().catch(() => undefined)
  })()
  const ceiling = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, QUIT_SHUTDOWN_CEILING_MS)
    timer.unref?.()
  })
  void Promise.race([shutdown, ceiling]).finally(() => app.exit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
