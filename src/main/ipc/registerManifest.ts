/**
 * Manifest-driven IPC registration (Audit A4). The declarative channel manifest
 * (src/shared/ipcManifest.ts) is the single source of truth; this module turns
 * it into ipcMain.handle / ipcMain.on registrations and enforces the declared
 * authorization level and central zod validation BEFORE the handler runs:
 *
 *   - auth 'not-voice':    invoke → assertNotVoiceWindow (throws);
 *                          send   → silently dropped for the voice overlay
 *   - auth 'main-window':  requireMainWindow (throws)
 *   - auth 'voice-window': send only; silently dropped for non-voice senders
 *   - auth 'any' | 'controller' | 'custom': nothing central — the handler body
 *     (or its controller / bespoke guard) is responsible, and the ipcSurface
 *     guard test pins that it actually is.
 *
 *   - validation 'schema': the payload at `schemaArg` (default 0) is parsed
 *     through the binding in src/shared/ipcManifestSchemas.ts via
 *     parseIpcPayload; `schemaOptional` lets `undefined` through untouched.
 *
 * Handler implementations stay in register.ts (the typed ManifestHandlers map);
 * only the wiring is tabular.
 */
import { ipcMain } from 'electron'
import {
  ipcManifest,
  listIpcChannels,
  type IpcChannelSpec,
  type IpcManifest,
  type IpcManifestKey,
  type ManifestApiOf
} from '@shared/ipcManifest'
import { ipcManifestSchemas, type SchemaValidatedKey } from '@shared/ipcManifestSchemas'
import { parseIpcPayload } from '@main/security/ipcPayload'

// ---------------------------------------------------------------------------
// Typed handler map derived from the manifest
// ---------------------------------------------------------------------------

/** Manifest keys that need a main-process handler (invoke + send). */
export type RegisterableManifestKey = {
  [K in IpcManifestKey]: IpcManifest[K] extends { kind: 'invoke' | 'send' } ? K : never
}[IpcManifestKey]

type AnyFn = (...args: never[]) => unknown
type ArgsOf<F> = F extends (...args: infer A) => unknown ? A : never
type ResultOf<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never

type InvokeHandler<F extends AnyFn> = (
  event: Electron.IpcMainInvokeEvent,
  ...args: ArgsOf<F>
) => ResultOf<F> | Promise<ResultOf<F>>

type SendHandler<F extends AnyFn> = (event: Electron.IpcMainEvent, ...args: ArgsOf<F>) => void

/**
 * One handler per registerable manifest entry, typed against the VertragusApi
 * member the channel serves — the renderer argument and result types cannot
 * drift from what the handler accepts and returns.
 */
export type ManifestHandlers = {
  [K in RegisterableManifestKey]: IpcManifest[K] extends { kind: 'send' }
    ? SendHandler<ManifestApiOf<K>>
    : InvokeHandler<ManifestApiOf<K>>
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface ManifestAuthDeps {
  /** Throws when the sender is the voice overlay window. */
  assertNotVoiceWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): void
  /** Throws when the sender is not the main window. */
  requireMainWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): void
  /** True when the sender WebContents belongs to the voice overlay window. */
  isVoiceWindowSender(sender: Electron.WebContents): boolean
}

type GenericHandler = (
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
  ...args: unknown[]
) => unknown

/**
 * Wraps a handler with the central auth + validation pipeline of its manifest
 * entry. Exported separately so the behavioral test can pin the semantics
 * without electron's ipcMain.
 */
export function createManifestChannelHandler(
  key: RegisterableManifestKey,
  handler: GenericHandler,
  deps: ManifestAuthDeps
): GenericHandler {
  const spec = ipcManifest[key] as IpcChannelSpec
  const schemaBinding =
    spec.validation === 'schema' ? ipcManifestSchemas[key as SchemaValidatedKey] : undefined
  if (spec.validation === 'schema' && !schemaBinding) {
    throw new Error(`IPC manifest: no schema binding for "${key}"`)
  }
  return (event, ...args) => {
    switch (spec.auth) {
      case 'not-voice':
        if (spec.kind === 'send') {
          // One-way channels drop unauthorized senders without a reply (hot paths).
          if (deps.isVoiceWindowSender(event.sender)) return undefined
        } else {
          deps.assertNotVoiceWindow(event)
        }
        break
      case 'main-window':
        deps.requireMainWindow(event)
        break
      case 'voice-window':
        if (!deps.isVoiceWindowSender(event.sender)) return undefined
        break
      // 'any' | 'controller' | 'custom': no central gate (see module doc).
    }
    if (schemaBinding) {
      const index = spec.schemaArg ?? 0
      if (!(spec.schemaOptional && args[index] === undefined)) {
        args[index] = parseIpcPayload(schemaBinding.schema, args[index], schemaBinding.label)
      }
    }
    return handler(event, ...args)
  }
}

/**
 * Registers every invoke/send channel of the manifest with ipcMain. The mapped
 * ManifestHandlers type guarantees at compile time that exactly the manifest's
 * registerable channels are provided — no missing and no extra handlers.
 */
export function registerManifestChannels(handlers: ManifestHandlers, deps: ManifestAuthDeps): void {
  const seen = new Set<string>()
  for (const { key, spec } of listIpcChannels()) {
    if (spec.kind !== 'invoke' && spec.kind !== 'send') continue
    if (seen.has(spec.channel)) {
      throw new Error(`IPC manifest: channel "${spec.channel}" registered twice`)
    }
    seen.add(spec.channel)
    const wrapped = createManifestChannelHandler(
      key as RegisterableManifestKey,
      handlers[key as RegisterableManifestKey] as GenericHandler,
      deps
    )
    if (spec.kind === 'invoke') {
      ipcMain.handle(spec.channel, wrapped)
    } else {
      ipcMain.on(spec.channel, (event, ...args) => void wrapped(event, ...args))
    }
  }
}
