/**
 * Accelerator validation for the hide-all hotkey field.
 *
 * Electron's `globalShortcut.register` answers two very different failures with
 * the same silence-shaped result: a MALFORMED accelerator throws deep inside
 * Electron, and a TAKEN one returns false. Only the second is worth reaching
 * the OS for — the first is a typo, and a typo deserves an answer while the
 * user is still typing, not after a round trip that also unregisters the
 * working hotkey they had before.
 *
 * So this module is the cheap gate and the main process stays the authority:
 * anything this rejects never leaves the window, and anything it accepts is
 * still reported honestly if the OS says no (see `hideAllHotkeyError`).
 *
 * The key list follows Electron's accelerator documentation. Being a little
 * stricter than Electron is fine here; being looser is not, because the throw
 * on the other side is what this exists to prevent.
 */
import {
  extraMcpServerSchema,
  normalizeMcpServerId,
  RESERVED_MCP_SERVER_ID,
  type ExtraMcpServer
} from '@shared/schema/mcpServer'
import type { Translate } from '../i18n'

/** Everything Electron accepts to the LEFT of the final key. */
export const ACCELERATOR_MODIFIERS = [
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta'
] as const

/** Named keys; single characters and F-keys are handled separately. */
const NAMED_KEYS = new Set([
  'plus',
  'space',
  'tab',
  'capslock',
  'numlock',
  'scrolllock',
  'backspace',
  'delete',
  'insert',
  'return',
  'enter',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'escape',
  'esc',
  'printscreen',
  'volumeup',
  'volumedown',
  'volumemute',
  'medianexttrack',
  'mediaprevioustrack',
  'mediastop',
  'mediaplaypause',
  'numdec',
  'numadd',
  'numsub',
  'nummult',
  'numdiv'
])

/** Punctuation Electron accepts as a bare key. */
const PUNCTUATION = new Set([...'0123456789', ...')!@#$%^&*(:;+=<,_->.?/~`{]|\\}"\''])

function isKey(raw: string): boolean {
  const key = raw.toLowerCase()
  if (key.length === 1) return /[a-z]/.test(key) || PUNCTUATION.has(raw)
  if (/^f([1-9]|1\d|2[0-4])$/.test(key)) return true
  if (/^num[0-9]$/.test(key)) return true
  return NAMED_KEYS.has(key)
}

export type AcceleratorCheck = { ok: true } | { ok: false; reason: string }

/**
 * Is this a plausible GLOBAL accelerator?
 *
 * Stricter than Electron in one deliberate place: a global shortcut must carry
 * at least one modifier. `globalShortcut.register('K')` is legal and swallows
 * the K key in every application on the machine — a setting no one wants and
 * nobody would connect to this window afterwards.
 */
export function validateAccelerator(t: Translate, value: string): AcceleratorCheck {
  const text = value.trim()
  if (!text) return { ok: false, reason: t('settings.errors.hotkeyEmpty') }

  const parts = text.split('+')
  // "Control+" and "Control++" both mean: the key is missing. The single
  // exception is a trailing "+" that IS the key, written as "Plus".
  const key = parts.pop() ?? ''
  if (!key) return { ok: false, reason: t('settings.errors.hotkeyNoKey') }
  if (parts.length === 0) return { ok: false, reason: t('settings.errors.hotkeyNoModifier') }

  const seen = new Set<string>()
  for (const part of parts) {
    const modifier = part.trim().toLowerCase()
    if (!(ACCELERATOR_MODIFIERS as readonly string[]).includes(modifier)) {
      return { ok: false, reason: t('settings.errors.hotkeyUnknownModifier', { part }) }
    }
    if (seen.has(modifier)) {
      return { ok: false, reason: t('settings.errors.hotkeyDuplicateModifier', { part }) }
    }
    seen.add(modifier)
  }

  if (!isKey(key)) return { ok: false, reason: t('settings.errors.hotkeyUnknownKey', { key }) }
  return { ok: true }
}

/** One argument per line; blank lines drop. */
export function parseArgLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** `KEY=value` per line. First `=` splits; empty keys drop. */
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    const key = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim()
    if (!key) continue
    env[key] = eq === -1 ? '' : trimmed.slice(eq + 1)
  }
  return env
}

/** `Name: value` per line. First `:` splits; empty names drop. */
export function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(':')
    const name = (colon === -1 ? trimmed : trimmed.slice(0, colon)).trim()
    if (!name) continue
    headers[name] = colon === -1 ? '' : trimmed.slice(colon + 1).trim()
  }
  return headers
}

export function formatEnvLines(env?: Record<string, string>): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

export function formatHeaderLines(headers?: Record<string, string>): string {
  return Object.entries(headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

export type McpServerDraft = {
  editingId?: string
  id: string
  label: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command: string
  argsText: string
  envText: string
  url: string
  headersText: string
}

export function emptyMcpDraft(): McpServerDraft {
  return {
    id: '',
    label: '',
    enabled: true,
    transport: 'stdio',
    command: '',
    argsText: '',
    envText: '',
    url: '',
    headersText: ''
  }
}

export function draftFromServer(server: ExtraMcpServer): McpServerDraft {
  const base = {
    editingId: server.id,
    id: server.id,
    label: server.label,
    enabled: server.enabled,
    command: '',
    argsText: '',
    envText: '',
    url: '',
    headersText: ''
  }
  if (server.transport === 'stdio') {
    return {
      ...base,
      transport: 'stdio',
      command: server.command,
      argsText: server.args.join('\n'),
      envText: formatEnvLines(server.env)
    }
  }
  return {
    ...base,
    transport: 'http',
    url: server.url,
    headersText: formatHeaderLines(server.headers)
  }
}

export type McpDraftErrors = Partial<Record<'id' | 'label' | 'command' | 'url', string>>

function omitEmptyMap(map: Record<string, string>): Record<string, string> | undefined {
  return Object.keys(map).length > 0 ? map : undefined
}

export function serverFromDraft(draft: McpServerDraft): unknown {
  const id = normalizeMcpServerId(draft.id) || draft.id.trim()
  if (draft.transport === 'http') {
    return {
      id,
      label: draft.label.trim(),
      enabled: draft.enabled,
      transport: 'http',
      url: draft.url.trim(),
      ...(omitEmptyMap(parseHeaderLines(draft.headersText))
        ? { headers: parseHeaderLines(draft.headersText) }
        : {})
    }
  }
  return {
    id,
    label: draft.label.trim(),
    enabled: draft.enabled,
    transport: 'stdio',
    command: draft.command.trim(),
    args: parseArgLines(draft.argsText),
    ...(omitEmptyMap(parseEnvLines(draft.envText)) ? { env: parseEnvLines(draft.envText) } : {})
  }
}

export function validateMcpDraft(
  t: Translate,
  draft: McpServerDraft,
  existing: readonly ExtraMcpServer[]
): { ok: true; server: ExtraMcpServer } | { ok: false; errors: McpDraftErrors } {
  const errors: McpDraftErrors = {}
  if (!draft.label.trim()) errors.label = t('settings.errors.mcpLabel')
  const id = normalizeMcpServerId(draft.id)
  if (!id || draft.id.includes('.') || id.includes('.')) errors.id = t('settings.errors.mcpId')
  else if (id === RESERVED_MCP_SERVER_ID) errors.id = t('settings.errors.mcpReserved')
  else {
    const taken = existing.some(
      (server) => server.id === id && server.id !== draft.editingId
    )
    if (taken) errors.id = t('settings.errors.mcpDuplicate')
  }
  if (draft.transport === 'stdio' && !draft.command.trim()) {
    errors.command = t('settings.errors.mcpCommand')
  }
  if (draft.transport === 'http' && !draft.url.trim()) {
    errors.url = t('settings.errors.mcpUrl')
  }

  const parsed = extraMcpServerSchema.safeParse(serverFromDraft(draft))
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path[0])
    if (paths.includes('url') && !errors.url) errors.url = t('settings.errors.mcpUrl')
    if (paths.includes('command') && !errors.command) errors.command = t('settings.errors.mcpCommand')
    if (paths.includes('id') && !errors.id) errors.id = t('settings.errors.mcpId')
    if (paths.includes('label') && !errors.label) errors.label = t('settings.errors.mcpLabel')
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  if (!parsed.success) {
    return {
      ok: false,
      errors:
        draft.transport === 'http'
          ? { url: t('settings.errors.mcpUrl') }
          : { command: t('settings.errors.mcpCommand') }
    }
  }
  return { ok: true, server: { ...parsed.data, id } }
}
