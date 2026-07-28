import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IPC } from '@shared/ipc'

/**
 * Audit A4 — the IPC surface is maintained in triplicate:
 *   (1) channel constants + VertragusApi types in src/shared/ipc.ts
 *   (2) the preload bridge in src/preload/index.ts (invoke / send / subscribe)
 *   (3) handler registration in src/main/ipc/register.ts (ipcMain.handle/on)
 *
 * Drift between the three used to surface only at runtime. This guard derives
 * all channel sets from the sources (no hard-coded full list, so purely
 * additive changes that follow the pattern stay green) and pins:
 *   (a) every channel the preload invokes/sends has a registered handler,
 *   (b) every registered handler is used by the preload — or is listed as a
 *       justified exception below,
 *   (c) every handler body shows an authorization marker and (when it takes a
 *       payload) a validation marker (zod parseIpcPayload / shared asserts /
 *       an authorizing controller) — or is listed as a justified exception,
 *   (d) every pushed main→renderer event channel has a preload subscriber and
 *       vice versa.
 *
 * When this test fails after adding a channel, the fix is almost always to
 * finish the pattern (constant + preload method + registered handler with
 * authorize + parse) — only add an exception with a reason when the deviation
 * is deliberate. See docs/IPC_ARCHITECTURE.md.
 */

const here = dirname(fileURLToPath(import.meta.url))
const registerSrc = readFileSync(join(here, 'register.ts'), 'utf8')
const preloadSrc = readFileSync(join(here, '../../preload/index.ts'), 'utf8')
const windowsSrc = readFileSync(join(here, '../windows.ts'), 'utf8')

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

function matchNames(src: string, re: RegExp): string[] {
  return [...src.matchAll(re)].map((m) => m[1]!)
}

interface Registration {
  kind: 'handle' | 'on'
  name: string
  /** Full `ipcMain.handle(...)` / `ipcMain.on(...)` call, parenthesis-balanced. */
  block: string
  /** Callback parameter list, split at top-level commas. */
  params: string[]
}

/** Extract the full registration call by balancing parentheses from `ipcMain.…(`. */
function extractRegistrations(src: string): Registration[] {
  const out: Registration[] = []
  const re = /ipcMain\.(handle|on)\(\s*IPC\.(\w+)\s*,/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const openIdx = src.indexOf('(', m.index)
    let depth = 0
    let i = openIdx
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    expect(depth, `unbalanced parentheses while parsing ipcMain.${m[1]}(IPC.${m[2]}…)`).toBe(0)
    const block = src.slice(m.index, i + 1)
    out.push({
      kind: m[1] as 'handle' | 'on',
      name: m[2]!,
      block,
      params: callbackParams(block, m[2]!)
    })
  }
  return out
}

/** Parameters of the handler callback: `(e, id: unknown) => …` → ['e', 'id: unknown']. */
function callbackParams(block: string, name: string): string[] {
  const after = block.replace(
    new RegExp(`^ipcMain\\.(?:handle|on)\\(\\s*IPC\\.${name}\\s*,\\s*(?:async\\s*)?`),
    ''
  )
  expect(after.startsWith('('), `cannot find callback parameter list for IPC.${name}`).toBe(true)
  let depth = 0
  let i = 0
  for (; i < after.length; i++) {
    if (after[i] === '(') depth++
    else if (after[i] === ')') {
      depth--
      if (depth === 0) break
    }
  }
  const inner = after.slice(1, i)
  // Top-level split is fine: no current parameter type contains a comma.
  return inner
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
}

const registrations = extractRegistrations(registerSrc)
const handled = new Set(registrations.filter((r) => r.kind === 'handle').map((r) => r.name))
const onRegistered = new Set(registrations.filter((r) => r.kind === 'on').map((r) => r.name))
const byName = new Map(registrations.map((r) => [r.name, r]))

// All IPC.* references in register.ts that are NOT a registration are pushes
// (broadcast(IPC.x, …), broadcastAgentData(IPC.x, …), sender.send(IPC.x, …)).
const registerRefs = new Set(matchNames(registerSrc, /IPC\.(\w+)/g))
const pushed = new Set([...registerRefs].filter((n) => !handled.has(n) && !onRegistered.has(n)))

// Preload: invoke / one-way send / everything else = event subscription.
const invoked = new Set(matchNames(preloadSrc, /ipcRenderer\.invoke\(\s*IPC\.(\w+)/g))
const sentOneWay = new Set(matchNames(preloadSrc, /ipcRenderer\.send\(\s*IPC\.(\w+)/g))
const preloadRefs = new Set(matchNames(preloadSrc, /IPC\.(\w+)/g))
const subscribed = new Set(
  [...preloadRefs].filter((n) => !invoked.has(n) && !sentOneWay.has(n))
)

const IPC_KEYS = new Set(Object.keys(IPC))
const EVENT_KEYS = new Set(
  Object.entries(IPC)
    .filter(([, value]) => value.startsWith('ev:'))
    .map(([key]) => key)
)

function missing(from: Iterable<string>, inSet: Set<string>, except: Set<string> = new Set()): string[] {
  return [...from].filter((n) => !inSet.has(n) && !except.has(n)).sort()
}

// ---------------------------------------------------------------------------
// Justified exceptions. Every entry needs a reason; stale entries fail the
// hygiene test below, so this list cannot rot.
// ---------------------------------------------------------------------------

/** Handlers registered in register.ts but (deliberately) not called from the preload. */
const HANDLERS_WITHOUT_PRELOAD_USE: Record<string, string> = {
  // currently none — every registered channel is bridged onto window.vertragus
}

/** Pushed event channels without a preload subscriber. */
const PUSHED_WITHOUT_SUBSCRIBER: Record<string, string> = {
  // currently none — every pushed ev:* channel has an on*-subscription
}

/**
 * Handlers whose body shows no authorization marker (assertNotVoiceWindow /
 * requireMainWindow / guard* / isVoiceWindowSender / *Controller.*). These are
 * callable from EVERY window that shares the renderer preload — including the
 * voice overlay. Only list channels here where that is acceptable.
 */
const AUTH_EXCEPTIONS: Record<string, string> = {
  appInfo: 'read-only app metadata',
  appUpdateState: 'read-only updater state',
  appUpdateCheck: 'benign trigger; updater state is broadcast to all windows anyway',
  appUpdateDownload: 'benign trigger of the signed-update download',
  appUpdateInstall: 'installs an already verified update; no payload',
  providersHealth: 'read-only provider probe',
  providersCapacity: 'read-only concurrency snapshot',
  providersModels: 'read-only model catalog',
  providerLogin: 'opens the provider CLI login pane; no secrets cross the bridge',
  diagnosticsExportLatest: 'read-only redacted export via a native save dialog parented to the sender',
  configGet: 'public config keys only (allow-listed in configAccess)',
  configSet: 'public config keys only; every window may persist shared UI settings',
  profilesList: 'read-only',
  profileGetActive: 'read-only',
  profileSetActive: 'selection pointer only; existence-checked against the store',
  mcpList: 'read-only (mcpSave is voice-guarded)',
  gitInfo: 'read-only repository inspection',
  githubProjects: 'read-only board listing',
  githubAuthStatus: 'read-only auth status (never tokens)',
  githubRepoResolve: 'read-only repo metadata lookup',
  githubRepoCheckLocal: 'read-only local clone check',
  demoPlay: 'pushes demo state only into the requesting window',
  dialogPickFolder: 'native picker; user interaction required, returns a user-chosen path',
  dialogPickFile: 'native picker; returns a short-lived grant, not a raw path',
  ideasList: 'read-only inbox listing',
  ideasGet: 'read-only',
  ideasCreate: 'inbox capture is intentionally reachable from every window (zod-parsed)',
  ideasUpdate: 'inbox mutation accepted from every window (zod-parsed)',
  ideasDelete: 'inbox mutation accepted from every window (id-validated)',
  ideasAddArtifact: 'inbox mutation accepted from every window (zod-parsed)',
  ideasRemoveArtifact: 'inbox mutation accepted from every window (id-validated)',
  ideasTransferToProfile: 'transfer request is zod-parsed; orchestrator start runs its own gates',
  ideasTransferRetry: 'id-validated retry of a previously authorized transfer',
  ideasTransferReset: 'id-validated metadata reset',
  inboxSpeechStatus: 'read-only STT status',
  inboxSpeechGetSettings: 'settings expose key presence as booleans only',
  inboxSpeechSetSettings: 'zod-parsed patch; raw keys never leave the main process',
  inboxSpeechTranscribe: 'bounded audio payload validated inside transcribeInboxAudio',
  inboxSpeechAbort: 'aborts the single in-flight transcription; no payload',
  agentsList: 'read-only agent listing',
  agentBuffer: 'read-only scrollback replay (id-validated)',
  agentBufferTail: 'read-only scrollback slice (id-validated)',
  orchestratorSnapshot: 'read-only snapshot; lenient by design for deleted profiles',
  orchestratorTaskDiff: 'read-only size-limited diff from the trusted worktree',
  retroListRetros: 'read-only',
  retroListLearnings: 'read-only',
  retroListBenchmarks: 'read-only',
  retroSyncStatus: 'read-only',
  retroSyncFlush: 'benign flush of the export queue; no payload',
  winMinimize: 'window control scoped to the sender window itself',
  winMaximizeToggle: 'window control scoped to the sender window itself',
  winClose: 'window control scoped to the sender window itself'
}

/**
 * Handlers that take a payload but show no shared validation marker
 * (parseIpcPayload / assertIpcId / assertIpcOptionalId / assertValidConfigKey /
 * requireProfile / *Controller.*). Each reason states where validation happens
 * instead — several of these are exactly the A4 drift this guard documents.
 */
const VALIDATION_EXCEPTIONS: Record<string, string> = {
  appUpdateSetChannel: 'inline whitelist: anything but "stable" falls back to "main"',
  diagnosticsExportLatest: 'profileId String()-coerced; only used as a journal list filter',
  profileGenerateForRepo:
    'DRIFT: request forwarded without zod at the boundary; validation lives inside generateProfileForRepo',
  profileSetActive: 'existence check via getProfile(id) against the store',
  sessionsRestartAgents: 'inline typeof checks on profileId/sessionId',
  sessionsDiscardOrphanWorktree: 'inline typeof check; path is matched against recorded orphans',
  sessionsDiscardOrphanWorktrees: 'inline Array/typeof checks',
  inboxSpeechTranscribe: 'bounded base64 payload enforced inside transcribeInboxAudio',
  remoteEnable: 'main-window-only; request validated inside remoteService.enable',
  remoteRevokeDevice: 'main-window-only; deviceId String()-coerced',
  remotePairStart: 'main-window-only; optional request validated inside remoteService.startPairing',
  remoteSetApnsConfig: 'main-window-only; config validated inside remoteService.setApnsConfig',
  orchestratorSnapshot:
    'read-only; getProfile lookup is deliberately lenient and returns an empty snapshot',
  orchestratorSetYoloMaster: 'Boolean() coercion is the whole contract',
  orchestratorSend: 'validated inside resolveOrchestratorSend (voiceIpc)',
  voiceAssistantTurn: 'request adapted + bounded inside adaptVoiceTurnRequest',
  voiceAssistantSetSettings: 'main-window-only; patch validated inside setVoiceAssistantSettings',
  retroListRetros: 'optional profileId String()-coerced list filter',
  retroListBenchmarks: 'optional profileId String()-coerced list filter',
  agentWrite: 'hot pty path; unknown ids are dropped inside AgentManager.write',
  agentMarkInteractiveUsed: 'unknown ids are ignored inside AgentManager',
  agentResize: 'unknown ids are ignored inside AgentManager; cols/rows clamped by pty',
  voiceOverlayMoved: 'voice-window-only; Number() coercion of window coordinates'
}

const AUTH_MARKERS =
  /assertNotVoiceWindow\(|requireMainWindow\(|guardVoiceTurnAllowed\(|guardOverlayControl\(|isVoiceWindowSender\(|Controller\.\w+\(/
const VALIDATION_MARKERS =
  /parseIpcPayload\(|assertIpcId\(|assertIpcOptionalId\(|assertValidConfigKey\(|requireProfile\(|Controller\.\w+\(/

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IPC channel constants (ipc.ts)', () => {
  it('channel string values are unique (an alias would silently merge two channels)', () => {
    const values = Object.values(IPC)
    const dupes = values.filter((v, i) => values.indexOf(v) !== i)
    expect(dupes, `duplicate channel strings: ${dupes.join(', ')}`).toEqual([])
  })

  it('renderer→main channels never use the ev: prefix, push channels always do', () => {
    for (const name of [...invoked, ...sentOneWay]) {
      expect(EVENT_KEYS.has(name), `${name} is invoked/sent but named like a push channel`).toBe(false)
    }
    for (const name of pushed) {
      expect(EVENT_KEYS.has(name), `${name} is pushed but lacks the ev: naming convention`).toBe(true)
    }
  })

  it('defines no orphan constants (unused in both preload and register)', () => {
    const used = new Set([...preloadRefs, ...registerRefs])
    expect(missing(IPC_KEYS, used)).toEqual([])
  })

  it('never registers a channel both as handle and on', () => {
    expect([...handled].filter((n) => onRegistered.has(n))).toEqual([])
  })
})

describe('preload ↔ register consistency', () => {
  it('(a) every preload invoke has a registered ipcMain.handle', () => {
    expect(
      missing(invoked, handled),
      'invoked in preload but never handled in register.ts'
    ).toEqual([])
  })

  it('(a) every preload one-way send has a registered ipcMain.on', () => {
    expect(
      missing(sentOneWay, onRegistered),
      'sent from preload but never subscribed via ipcMain.on'
    ).toEqual([])
  })

  it('(b) every registered handler is used by the preload (or is a justified exception)', () => {
    const except = new Set(Object.keys(HANDLERS_WITHOUT_PRELOAD_USE))
    expect(
      missing(handled, invoked, except),
      'handled in register.ts but never invoked from preload (dead handler?)'
    ).toEqual([])
    expect(
      missing(onRegistered, sentOneWay, except),
      'ipcMain.on-registered but never sent from preload (dead handler?)'
    ).toEqual([])
  })

  it('(d) every pushed event channel has a preload subscriber (or is a justified exception)', () => {
    const except = new Set(Object.keys(PUSHED_WITHOUT_SUBSCRIBER))
    expect(
      missing(pushed, subscribed, except),
      'pushed from main but nobody subscribes in preload'
    ).toEqual([])
  })

  it('(d) every preload subscription has a main-side sender', () => {
    expect(
      missing(subscribed, pushed),
      'subscribed in preload but never pushed from register.ts'
    ).toEqual([])
  })

  it('raw ev:* string literals outside ipc.ts refer to real channels (windows.ts pushDemoState)', () => {
    const values = new Set<string>(Object.values(IPC))
    const literals = matchNames(windowsSrc, /'(ev:[^']+)'/g)
    // pushDemoState sends demo snapshots with literal channel names — a typo
    // there would silently push into the void.
    const unknown = literals.filter((l) => !values.has(l))
    expect(unknown, `windows.ts sends to non-existent event channels: ${unknown.join(', ')}`).toEqual([])
  })
})

describe('(c) authorization + payload validation per handler', () => {
  it('every handler shows an authorization marker or is a documented exception', () => {
    const offenders = registrations
      .filter((r) => !AUTH_MARKERS.test(r.block) && !(r.name in AUTH_EXCEPTIONS))
      .map((r) => r.name)
    expect(
      offenders,
      'handlers without an authorization marker — add assertNotVoiceWindow/requireMainWindow ' +
        '(or an authorizing controller), or document the exception in AUTH_EXCEPTIONS with a reason'
    ).toEqual([])
  })

  it('every handler that takes a payload shows a validation marker or is a documented exception', () => {
    const offenders = registrations
      .filter(
        (r) =>
          r.params.length >= 2 &&
          !VALIDATION_MARKERS.test(r.block) &&
          !(r.name in VALIDATION_EXCEPTIONS)
      )
      .map((r) => r.name)
    expect(
      offenders,
      'payload-taking handlers without parseIpcPayload/assertIpcId/… — validate the payload ' +
        'or document the exception in VALIDATION_EXCEPTIONS with a reason'
    ).toEqual([])
  })

  it('exception lists carry no stale entries', () => {
    for (const name of Object.keys(AUTH_EXCEPTIONS)) {
      const reg = byName.get(name)
      expect(reg, `AUTH_EXCEPTIONS lists unregistered channel ${name}`).toBeTruthy()
      expect(
        AUTH_MARKERS.test(reg!.block),
        `AUTH_EXCEPTIONS entry ${name} is stale — the handler now has an authorization marker`
      ).toBe(false)
    }
    for (const name of Object.keys(VALIDATION_EXCEPTIONS)) {
      const reg = byName.get(name)
      expect(reg, `VALIDATION_EXCEPTIONS lists unregistered channel ${name}`).toBeTruthy()
      expect(
        reg!.params.length >= 2,
        `VALIDATION_EXCEPTIONS entry ${name} is stale — the handler takes no payload`
      ).toBe(true)
      expect(
        VALIDATION_MARKERS.test(reg!.block),
        `VALIDATION_EXCEPTIONS entry ${name} is stale — the handler now validates via shared helpers`
      ).toBe(false)
    }
    for (const name of Object.keys(HANDLERS_WITHOUT_PRELOAD_USE)) {
      expect(byName.has(name), `HANDLERS_WITHOUT_PRELOAD_USE lists unregistered channel ${name}`).toBe(true)
      expect(
        invoked.has(name) || sentOneWay.has(name),
        `HANDLERS_WITHOUT_PRELOAD_USE entry ${name} is stale — the preload uses it now`
      ).toBe(false)
    }
    for (const name of Object.keys(PUSHED_WITHOUT_SUBSCRIBER)) {
      expect(pushed.has(name), `PUSHED_WITHOUT_SUBSCRIBER lists unpushed channel ${name}`).toBe(true)
      expect(
        subscribed.has(name),
        `PUSHED_WITHOUT_SUBSCRIBER entry ${name} is stale — the preload subscribes now`
      ).toBe(false)
    }
  })

  it('parses a plausible surface (guards against the parser itself rotting)', () => {
    expect(handled.size).toBeGreaterThan(80)
    expect(onRegistered.size).toBeGreaterThanOrEqual(5)
    expect(pushed.size).toBeGreaterThanOrEqual(8)
    expect(invoked.size).toBeGreaterThan(80)
    expect(subscribed.size).toBeGreaterThanOrEqual(8)
  })
})
