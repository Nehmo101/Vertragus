import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IPC } from '@shared/ipc'
import {
  buildVertragusApi,
  listIpcChannels,
  type CustomBridgeBindings,
  type IpcChannelSpec,
  type IpcManifestKey,
  type IpcTransport
} from '@shared/ipcManifest'
import { ipcManifestSchemas } from '@shared/ipcManifestSchemas'

/**
 * Audit A4 — the IPC surface guard, manifest edition.
 *
 * The declarative manifest (src/shared/ipcManifest.ts) is the single source of
 * truth: preload bindings are built from it (buildVertragusApi) and the main
 * process registers handlers from it (registerManifestChannels), so the old
 * "triplicate drift" classes are prevented by construction. What this guard
 * still pins:
 *   (a) manifest ↔ IPC constants stay 1:1 (keys, channel strings, ev: naming),
 *   (b) the handler map in register.ts covers exactly the manifest's
 *       registerable channels, and channels whose authorization/validation is
 *       NOT central ('controller' / 'custom' auth, 'handler' validation) really
 *       show the corresponding marker in their handler body,
 *   (c) the set of deliberately window-open channels (auth 'any') and the
 *       handler-validated payload channels are pinned as exact, justified
 *       lists — opening a new channel requires editing this test,
 *   (d) every pushed ev:* channel is a manifest event entry and vice versa,
 *   (e) no channel is wired in both worlds: legacy `ipcMain.handle(IPC.…)`
 *       registrations in register.ts (currently none) must stay disjoint from
 *       the manifest and satisfy the old auth/validation source patterns.
 *
 * Central 'not-voice' / 'main-window' / 'voice-window' enforcement and the
 * central zod parse are covered behaviorally in registerManifest.test.ts; the
 * generic preload bridge behaviorally in src/shared/ipcManifest.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url))
const registerSrc = readFileSync(join(here, 'register.ts'), 'utf8')
const preloadSrc = readFileSync(join(here, '../../preload/index.ts'), 'utf8')
const windowsSrc = readFileSync(join(here, '../windows.ts'), 'utf8')

// ---------------------------------------------------------------------------
// Manifest-derived sets
// ---------------------------------------------------------------------------

const entries = listIpcChannels()
const byKey = new Map(entries.map((e) => [e.key as string, e.spec]))
const registerable = entries.filter((e) => e.spec.kind === 'invoke' || e.spec.kind === 'send')
const invokeEntries = entries.filter((e) => e.spec.kind === 'invoke')
const sendEntries = entries.filter((e) => e.spec.kind === 'send')
const eventEntries = entries.filter((e) => e.spec.kind === 'event')
const localEntries = entries.filter((e) => e.spec.kind === 'local')

const IPC_KEYS = Object.keys(IPC) as (keyof typeof IPC)[]
const IPC_VALUES = new Set<string>(Object.values(IPC))

/**
 * Event channels deliberately exposed under a second API path. Keyed by the
 * extra manifest key, value = the IPC key it aliases.
 */
const EVENT_ALIASES: Record<string, string> = {
  voiceAssistantOnProgress: 'evVoiceAssistant'
}

// ---------------------------------------------------------------------------
// register.ts handler-map parsing
// ---------------------------------------------------------------------------

interface HandlerEntry {
  name: string
  /** Full property source (arrow function incl. body). */
  body: string
  /** Callback parameter list, split at top-level commas. */
  params: string[]
}

function extractHandlerMap(src: string): HandlerEntry[] {
  const marker = 'const manifestHandlers: ManifestHandlers = {'
  const start = src.indexOf(marker)
  expect(start, 'expected a `const manifestHandlers: ManifestHandlers = {` map in register.ts').toBeGreaterThan(-1)
  const openIdx = start + marker.length - 1
  let depth = 0
  let end = openIdx
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++
    else if (src[end] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  expect(depth, 'unbalanced braces while parsing the manifestHandlers map').toBe(0)
  const block = src.slice(openIdx + 1, end)
  // Top-level properties sit at indent 4 (`\n    name: …`); everything nested
  // is indented deeper, comments never match `word: `.
  const re = /\n {4}(\w+): /g
  const found: { name: string; start: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(block))) found.push({ name: m[1]!, start: m.index })
  return found.map((prop, i) => {
    const body = block.slice(prop.start, found[i + 1]?.start ?? block.length)
    return { name: prop.name, body, params: handlerParams(body, prop.name) }
  })
}

/** Parameters of the handler arrow: `name: async (e, id) => …` → ['e', 'id']. */
function handlerParams(body: string, name: string): string[] {
  const after = body.replace(new RegExp(`^\\n {4}${name}: (?:async\\s*)?`), '')
  expect(after.startsWith('('), `cannot find parameter list for handler ${name}`).toBe(true)
  let depth = 0
  let i = 0
  for (; i < after.length; i++) {
    if (after[i] === '(') depth++
    else if (after[i] === ')') {
      depth--
      if (depth === 0) break
    }
  }
  return after
    .slice(1, i)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
}

const handlerEntries = extractHandlerMap(registerSrc)
const handlersByName = new Map(handlerEntries.map((h) => [h.name, h]))

// Legacy world: direct ipcMain registrations in register.ts (old pattern).
const legacyRegistrations = [
  ...registerSrc.matchAll(/ipcMain\.(handle|on)\(\s*IPC\.(\w+)/g)
].map((m) => ({ kind: m[1]!, name: m[2]! }))

/** Channels intentionally left on the legacy (non-manifest) registration path. */
const LEGACY_CHANNELS: Record<string, string> = {
  // currently none — all 116 renderer→main channels are manifest-registered
}

// ---------------------------------------------------------------------------
// Pinned authorization / validation review lists. Every entry needs a reason
// (in the manifest `note`); stale entries fail the hygiene checks below.
// ---------------------------------------------------------------------------

/**
 * Channels with manifest auth 'any': callable from EVERY window that shares the
 * renderer preload — including the voice overlay. Opening a channel this way
 * must be a reviewed decision, so the exact set is pinned here; the reason
 * lives in the manifest entry's `note`.
 */
const EXPECTED_OPEN_CHANNELS = [
  'agentBuffer',
  'agentBufferTail',
  'agentsList',
  'appInfo',
  'appUpdateCheck',
  'appUpdateDownload',
  'appUpdateInstall',
  'appUpdateState',
  'configGet',
  'configSet',
  'demoPlay',
  'diagnosticsExportLatest',
  'dialogPickFile',
  'dialogPickFolder',
  'gitInfo',
  'githubAuthStatus',
  'githubProjects',
  'githubRepoCheckLocal',
  'githubRepoResolve',
  'ideasAddArtifact',
  'ideasCreate',
  'ideasDelete',
  'ideasGet',
  'ideasList',
  'ideasRemoveArtifact',
  'ideasTransferReset',
  'ideasTransferRetry',
  'ideasTransferToProfile',
  'ideasUpdate',
  'inboxSpeechAbort',
  'inboxSpeechGetSettings',
  'inboxSpeechSetSettings',
  'inboxSpeechStatus',
  'inboxSpeechTranscribe',
  'mcpList',
  'orchestratorSnapshot',
  'orchestratorTaskDiff',
  'profileGetActive',
  'profileSetActive',
  'profilesList',
  'providerLogin',
  'providersCapacity',
  'providersHealth',
  'providersModels',
  'retroListBenchmarks',
  'retroListLearnings',
  'retroListRetros',
  'retroSyncFlush',
  'retroSyncStatus',
  'winClose',
  'winMaximizeToggle',
  'winMinimize'
].sort()

/** Channels restricted to the main window (Mission Control & friends). */
const EXPECTED_MAIN_WINDOW_CHANNELS = [
  'orchestratorSend',
  'remoteClearApnsConfig',
  'remoteDisable',
  'remoteEnable',
  'remoteGetApnsConfigStatus',
  'remoteListDevices',
  'remotePairStart',
  'remoteRevokeDevice',
  'remoteSetApnsConfig',
  'remoteStatus',
  'railToggle',
  'voiceAssistantGetSettings',
  'voiceAssistantSetSettings',
  'voiceOverlayToggle'
].sort()

/** Channels whose authorization lives in a sender-checking controller. */
const EXPECTED_CONTROLLER_CHANNELS = [
  'attentionSetPendingFeedbackCount',
  'ideasAbortPromptEnhancement',
  'ideasEnhancePrompt',
  'ideasRemoveAttribute',
  'ideasRestore',
  'profileDelete',
  'profileSave',
  'workspaceSessionRemove',
  'workspaceSessionSetActive',
  'workspaceSessionsList'
].sort()

/** Channels with a bespoke guard inside the handler body. */
const EXPECTED_CUSTOM_AUTH_CHANNELS = [
  'railLaunchTiled',
  'railOpenMain',
  'voiceAssistantTurn',
  'voiceOverlayHide'
].sort()

/** Channels restricted to the voice overlay window (send-only). */
const EXPECTED_VOICE_WINDOW_CHANNELS = ['voiceOverlayMoved'].sort()

/**
 * Handlers that take a payload (validation 'handler') but show no shared
 * validation marker (assertIpcId / assertIpcOptionalId / assertValidConfigKey /
 * requireProfile / *Controller.*) in their body. Each reason states where
 * validation happens instead — several are exactly the A4 drift this guard
 * documents.
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
  /assertNotVoiceWindow\(|requireMainWindow\(|guardVoiceTurnAllowed\(|guardOverlayControl\(|guardRailControl\(|isVoiceWindowSender\(|isRailWindowSender\(|Controller\.\w+\(/
const VALIDATION_MARKERS =
  /parseIpcPayload\(|assertIpcId\(|assertIpcOptionalId\(|assertValidConfigKey\(|requireProfile\(|Controller\.\w+\(/
const CONTROLLER_MARKER = /Controller\.\w+\(/
const CUSTOM_GUARD_MARKER = /guardVoiceTurnAllowed\(|guardOverlayControl\(|guardRailControl\(|isRailWindowSender\(/

function sortedKeys(specs: { key: IpcManifestKey; spec: IpcChannelSpec }[]): string[] {
  return specs.map((e) => e.key as string).sort()
}

// ---------------------------------------------------------------------------
// (a) manifest ↔ IPC constants
// ---------------------------------------------------------------------------

describe('IPC constants ↔ manifest', () => {
  it('channel string values in ipc.ts are unique (an alias would silently merge two channels)', () => {
    const values = Object.values(IPC)
    const dupes = values.filter((v, i) => values.indexOf(v) !== i)
    expect(dupes, `duplicate channel strings: ${dupes.join(', ')}`).toEqual([])
  })

  it('every IPC constant has a manifest entry under the same key with the same channel string', () => {
    const broken = IPC_KEYS.filter((key) => byKey.get(key)?.channel !== IPC[key])
    expect(
      broken,
      'IPC keys without a same-named manifest entry (or with a mismatched channel string)'
    ).toEqual([])
  })

  it('every manifest entry maps to a real IPC constant (aliases and locals are declared)', () => {
    for (const { key, spec } of entries) {
      if (spec.kind === 'local') {
        expect(spec.channel, `local entry ${key} must not claim a channel`).toBe('')
        continue
      }
      expect(IPC_VALUES.has(spec.channel), `${key} targets unknown channel "${spec.channel}"`).toBe(
        true
      )
      if (!(key in IPC)) {
        const aliased = EVENT_ALIASES[key]
        expect(aliased, `${key} is not an IPC key and not a declared alias`).toBeTruthy()
        expect(spec.kind, `alias ${key} must be an event entry`).toBe('event')
        expect(spec.channel).toBe(IPC[aliased as keyof typeof IPC])
        expect(spec.note, `alias ${key} needs an explanatory note`).toBeTruthy()
      }
    }
  })

  it('no two non-event entries share a channel (a duplicate registration would silently override)', () => {
    const seen = new Map<string, number>()
    for (const { spec } of registerable) seen.set(spec.channel, (seen.get(spec.channel) ?? 0) + 1)
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c)
    expect(dupes).toEqual([])
  })

  it('renderer→main channels never use the ev: prefix, event entries always do', () => {
    for (const { key, spec } of registerable) {
      expect(spec.channel.startsWith('ev:'), `${key} is invoke/send but named like a push channel`).toBe(false)
    }
    for (const { key, spec } of eventEntries) {
      expect(spec.channel.startsWith('ev:'), `${key} is an event but lacks the ev: naming convention`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// (b) handler map ↔ manifest
// ---------------------------------------------------------------------------

describe('register.ts handler map ↔ manifest', () => {
  it('the handler map covers exactly the registerable manifest channels', () => {
    expect(handlerEntries.map((h) => h.name).sort()).toEqual(sortedKeys(registerable))
  })

  it("auth 'controller' handlers call their controller in the body", () => {
    for (const key of EXPECTED_CONTROLLER_CHANNELS) {
      const handler = handlersByName.get(key)
      expect(handler, `missing handler for controller channel ${key}`).toBeTruthy()
      expect(
        CONTROLLER_MARKER.test(handler!.body),
        `${key} declares auth 'controller' but its handler body calls no *Controller.* method`
      ).toBe(true)
    }
  })

  it("auth 'custom' handlers show their bespoke guard in the body", () => {
    for (const key of EXPECTED_CUSTOM_AUTH_CHANNELS) {
      const handler = handlersByName.get(key)
      expect(handler, `missing handler for custom-auth channel ${key}`).toBeTruthy()
      expect(
        CUSTOM_GUARD_MARKER.test(handler!.body),
        `${key} declares auth 'custom' but its handler body shows no guard* call`
      ).toBe(true)
    }
  })

  it("validation 'none' handlers take no payload parameters", () => {
    for (const { key, spec } of registerable) {
      if (spec.validation !== 'none') continue
      const handler = handlersByName.get(key as string)!
      expect(
        handler.params.length,
        `${key} declares validation 'none' but its handler takes payload parameters`
      ).toBeLessThanOrEqual(1)
    }
  })

  it("validation 'handler' channels take a payload and validate it (or are documented exceptions)", () => {
    const offenders: string[] = []
    for (const { key, spec } of registerable) {
      if (spec.validation !== 'handler') continue
      const handler = handlersByName.get(key as string)!
      expect(
        handler.params.length,
        `${key} declares validation 'handler' but takes no payload — declare 'none'`
      ).toBeGreaterThanOrEqual(2)
      if (!VALIDATION_MARKERS.test(handler.body) && !(key in VALIDATION_EXCEPTIONS)) {
        offenders.push(key as string)
      }
    }
    expect(
      offenders,
      'payload-taking handlers without assertIpcId/requireProfile/…-marker — validate the payload ' +
        'or document the exception in VALIDATION_EXCEPTIONS with a reason'
    ).toEqual([])
  })

  it("validation 'schema' channels have a binding in ipcManifestSchemas (and vice versa)", () => {
    const declared = registerable
      .filter((e) => e.spec.validation === 'schema')
      .map((e) => e.key as string)
      .sort()
    expect(Object.keys(ipcManifestSchemas).sort()).toEqual(declared)
    for (const { key, spec } of registerable) {
      if (spec.validation !== 'schema') continue
      const handler = handlersByName.get(key as string)!
      const payloadIndex = (spec.schemaArg ?? 0) + 1 // + event parameter
      expect(
        handler.params.length,
        `${key} parses argument ${spec.schemaArg ?? 0} centrally but its handler takes fewer parameters`
      ).toBeGreaterThan(payloadIndex)
    }
  })
})

// ---------------------------------------------------------------------------
// (c) pinned authorization sets + hygiene
// ---------------------------------------------------------------------------

describe('authorization levels are pinned and justified', () => {
  it("the exact set of window-open channels (auth 'any') matches the reviewed list", () => {
    expect(sortedKeys(registerable.filter((e) => e.spec.auth === 'any'))).toEqual(
      EXPECTED_OPEN_CHANNELS
    )
  })

  it("every auth 'any' entry carries a justification note in the manifest", () => {
    const missingNote = registerable
      .filter((e) => e.spec.auth === 'any' && !e.spec.note)
      .map((e) => e.key)
    expect(missingNote, "auth 'any' without a manifest note").toEqual([])
  })

  it('the main-window / controller / custom / voice-window sets match the reviewed lists', () => {
    expect(sortedKeys(registerable.filter((e) => e.spec.auth === 'main-window'))).toEqual(
      EXPECTED_MAIN_WINDOW_CHANNELS
    )
    expect(sortedKeys(registerable.filter((e) => e.spec.auth === 'controller'))).toEqual(
      EXPECTED_CONTROLLER_CHANNELS
    )
    expect(sortedKeys(registerable.filter((e) => e.spec.auth === 'custom'))).toEqual(
      EXPECTED_CUSTOM_AUTH_CHANNELS
    )
    expect(sortedKeys(registerable.filter((e) => e.spec.auth === 'voice-window'))).toEqual(
      EXPECTED_VOICE_WINDOW_CHANNELS
    )
  })

  it('exception lists carry no stale entries', () => {
    for (const [name, reason] of Object.entries(VALIDATION_EXCEPTIONS)) {
      expect(reason.length, `VALIDATION_EXCEPTIONS entry ${name} needs a reason`).toBeGreaterThan(0)
      const spec = byKey.get(name)
      expect(spec, `VALIDATION_EXCEPTIONS lists unknown channel ${name}`).toBeTruthy()
      expect(
        spec!.validation,
        `VALIDATION_EXCEPTIONS entry ${name} is stale — the channel no longer declares validation 'handler'`
      ).toBe('handler')
      const handler = handlersByName.get(name)
      expect(handler, `VALIDATION_EXCEPTIONS lists unregistered channel ${name}`).toBeTruthy()
      expect(
        VALIDATION_MARKERS.test(handler!.body),
        `VALIDATION_EXCEPTIONS entry ${name} is stale — the handler now validates via shared helpers`
      ).toBe(false)
    }
    for (const [name, reason] of Object.entries(LEGACY_CHANNELS)) {
      expect(reason.length, `LEGACY_CHANNELS entry ${name} needs a reason`).toBeGreaterThan(0)
      expect(
        legacyRegistrations.some((r) => r.name === name),
        `LEGACY_CHANNELS entry ${name} is stale — no direct ipcMain registration exists`
      ).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// (d) events
// ---------------------------------------------------------------------------

describe('push events', () => {
  it('register.ts references IPC constants only for push channels (all wiring is manifest-driven)', () => {
    const eventKeys = new Set(eventEntries.map((e) => e.key as string))
    const refs = new Set([...registerSrc.matchAll(/IPC\.(\w+)/g)].map((m) => m[1]!))
    const nonEvent = [...refs].filter((n) => !eventKeys.has(n))
    expect(
      nonEvent.sort(),
      'register.ts references non-event IPC constants directly — new channels belong in the manifest'
    ).toEqual([])
  })

  it('every manifest event channel is pushed from register.ts', () => {
    const pushed = new Set([...registerSrc.matchAll(/IPC\.(\w+)/g)].map((m) => m[1]!))
    const unpushed = eventEntries
      .map((e) => e.key as string)
      .filter((key) => !(key in EVENT_ALIASES))
      .filter((key) => !pushed.has(key))
    expect(unpushed, 'manifest event entries nobody pushes from register.ts').toEqual([])
  })

  it('raw ev:* string literals outside ipc.ts refer to real channels (windows.ts pushDemoState)', () => {
    const literals = [...windowsSrc.matchAll(/'(ev:[^']+)'/g)].map((m) => m[1]!)
    // pushDemoState sends demo snapshots with literal channel names — a typo
    // there would silently push into the void.
    const unknown = literals.filter((l) => !IPC_VALUES.has(l))
    expect(unknown, `windows.ts sends to non-existent event channels: ${unknown.join(', ')}`).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// (e) legacy world stays empty / disjoint
// ---------------------------------------------------------------------------

describe('legacy registrations', () => {
  it('no channel is registered both via the manifest and via a direct ipcMain call', () => {
    const manifestKeys = new Set(registerable.map((e) => e.key as string))
    const doubled = legacyRegistrations.filter((r) => manifestKeys.has(r.name)).map((r) => r.name)
    expect(doubled, 'channels wired in BOTH worlds (manifest + direct ipcMain)').toEqual([])
  })

  it('every direct ipcMain registration is a declared legacy exception with the old safety patterns', () => {
    for (const reg of legacyRegistrations) {
      expect(
        reg.name in LEGACY_CHANNELS,
        `undeclared legacy registration ipcMain.${reg.kind}(IPC.${reg.name}) — migrate it into the manifest ` +
          'or document it in LEGACY_CHANNELS with a reason'
      ).toBe(true)
      // Legacy handlers must keep the old inline auth/validation discipline.
      const block = registerSrc.slice(registerSrc.indexOf(`ipcMain.${reg.kind}(IPC.${reg.name}`))
      const head = block.slice(0, 2000)
      expect(
        AUTH_MARKERS.test(head),
        `legacy handler ${reg.name} shows no authorization marker`
      ).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// preload: custom bindings + plausibility
// ---------------------------------------------------------------------------

describe('preload bridge', () => {
  const customKeys = entries.filter((e) => e.spec.bridge === 'custom').map((e) => e.key as string)

  it('declares a hand-written binding for every bridge:custom manifest entry', () => {
    for (const key of customKeys) {
      expect(
        new RegExp(`\\n {2}${key}: `).test(preloadSrc),
        `preload customBindings is missing "${key}"`
      ).toBe(true)
    }
  })

  it('references IPC constants only for its custom bindings (everything else is generic)', () => {
    const refs = new Set([...preloadSrc.matchAll(/IPC\.(\w+)/g)].map((m) => m[1]!))
    const allowed = new Set(customKeys)
    const stray = [...refs].filter((n) => !allowed.has(n))
    expect(
      stray.sort(),
      'preload wires channels outside the manifest-driven builder — extend customBindings/manifest instead'
    ).toEqual([])
  })

  it('builds a bridge function for every manifest entry on its exact channel', () => {
    const calls: { kind: string; channel: string }[] = []
    const transport: IpcTransport = {
      invoke: async (channel) => {
        calls.push({ kind: 'invoke', channel })
        return undefined
      },
      send: (channel) => {
        calls.push({ kind: 'send', channel })
      },
      subscribe: (channel) => {
        calls.push({ kind: 'subscribe', channel })
        return () => {}
      }
    }
    const custom = Object.fromEntries(customKeys.map((k) => [k, () => undefined]))
    const api = buildVertragusApi(transport, custom as unknown as CustomBridgeBindings) as unknown as Record<string, unknown>
    for (const { key, spec } of entries) {
      const fn = spec.api
        .split('.')
        .reduce<unknown>((cursor, segment) => (cursor as Record<string, unknown>)[segment], api)
      expect(typeof fn, `built api misses a function at ${spec.api} (${key})`).toBe('function')
      if (spec.bridge === 'custom') continue
      calls.length = 0
      ;(fn as (...args: unknown[]) => unknown)(() => {})
      expect(calls, `${key} bridged onto the wrong transport/channel`).toEqual([
        {
          kind: spec.kind === 'invoke' ? 'invoke' : spec.kind === 'send' ? 'send' : 'subscribe',
          channel: spec.channel
        }
      ])
    }
  })
})

// ---------------------------------------------------------------------------
// plausibility floors (guards against the parser / manifest rotting)
// ---------------------------------------------------------------------------

describe('surface plausibility', () => {
  it('parses a plausible surface', () => {
    expect(invokeEntries.length).toBeGreaterThan(100)
    expect(sendEntries.length).toBeGreaterThanOrEqual(8)
    expect(eventEntries.length).toBeGreaterThanOrEqual(11)
    expect(localEntries.length).toBeGreaterThanOrEqual(1)
    expect(handlerEntries.length).toBeGreaterThan(100)
    expect(Object.keys(ipcManifestSchemas).length).toBeGreaterThanOrEqual(10)
  })
})
