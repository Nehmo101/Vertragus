/**
 * Extra MCP servers the user configures globally (Settings), attached next to
 * the built-in Vertragus server on every spawn whose provider `mcp.kind` is
 * not `none`. Subagents only — the orchestrator launch stays the one-server
 * Vertragus loopback.
 *
 * Secrets (env values, header values) live in AppSettings. They never ride
 * on PanelSettings / `ev:settings`; those surfaces see keys + `set` flags.
 *
 * Pure data + zod only (no Node imports) so main, preload and renderer share
 * one source of truth. Fail-soft on read, fail-closed on write.
 */
import { z } from 'zod'
import { normalizeProviderId } from './provider'

/** Built-in Vertragus MCP namespace — extra servers may not reuse this id. */
export const RESERVED_MCP_SERVER_ID = 'vertragus'

export const MAX_EXTRA_MCP_SERVERS = 16
export const MAX_MCP_SECRET_ENTRIES = 32

const MAX_ID_LENGTH = 64
const MAX_LABEL_LENGTH = 80
const MAX_COMMAND_LENGTH = 200
const MAX_URL_LENGTH = 400
const MAX_ARG_LENGTH = 400
const MAX_ARGS = 64
const MAX_MAP_KEY_LENGTH = 200
const MAX_MAP_VALUE_LENGTH = 2000
const MAX_MAP_ENTRIES = MAX_MCP_SECRET_ENTRIES

/** True for the in-app loopback server name, case-insensitive. */
export function isReservedMcpServerId(id: string): boolean {
  return id.trim().toLowerCase() === RESERVED_MCP_SERVER_ID
}

/**
 * Same lowercase / punctuation rules as provider ids, including `.`.
 * Extra MCP ids that still contain a `.` after this are rejected — Codex
 * `-c mcp_servers.${id}.*` treats dots as TOML nesting.
 */
export function normalizeMcpServerId(id: string): string {
  return normalizeProviderId(id)
}

function mcpServerIdHasDot(id: string): boolean {
  return id.includes('.')
}

const extraMcpMapSchema = z
  .record(z.string().trim().min(1).max(MAX_MAP_KEY_LENGTH), z.string().max(MAX_MAP_VALUE_LENGTH))
  .refine((value) => Object.keys(value).length <= MAX_MAP_ENTRIES, {
    message: 'too many entries'
  })
  .optional()

const extraMcpServerBase = {
  id: z
    .string()
    .trim()
    .min(1)
    .max(MAX_ID_LENGTH)
    .refine((value) => !mcpServerIdHasDot(value), {
      message: 'mcp server id cannot contain a dot'
    }),
  label: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
  enabled: z.boolean().default(true)
}

export const extraMcpServerSchema = z.discriminatedUnion('transport', [
  z
    .object({
      transport: z.literal('stdio'),
      ...extraMcpServerBase,
      command: z.string().trim().min(1).max(MAX_COMMAND_LENGTH),
      args: z.array(z.string().max(MAX_ARG_LENGTH)).max(MAX_ARGS).default([]),
      env: extraMcpMapSchema
    })
    .strict(),
  z
    .object({
      transport: z.literal('http'),
      ...extraMcpServerBase,
      url: z.string().trim().url().max(MAX_URL_LENGTH),
      headers: extraMcpMapSchema
    })
    .strict()
])

export type ExtraMcpServer = z.infer<typeof extraMcpServerSchema>
export type ExtraMcpServerInput = z.input<typeof extraMcpServerSchema>

function withNormalizedId(server: ExtraMcpServer): ExtraMcpServer | undefined {
  const id = normalizeMcpServerId(server.id)
  if (!id || id === RESERVED_MCP_SERVER_ID || mcpServerIdHasDot(id)) return undefined
  return { ...server, id }
}

/**
 * Validate and normalize a raw extra-server list. Invalid, reserved-id and
 * duplicate rows drop; first id wins. A non-array is `[]`.
 */
export function parseExtraMcpServers(raw: unknown): ExtraMcpServer[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: ExtraMcpServer[] = []
  for (const entry of raw) {
    if (result.length >= MAX_EXTRA_MCP_SERVERS) break
    const parsed = extraMcpServerSchema.safeParse(entry)
    if (!parsed.success) continue
    const server = withNormalizedId(parsed.data)
    if (!server || seen.has(server.id)) continue
    seen.add(server.id)
    result.push(server)
  }
  return result
}

/**
 * Strict write path: throw on a non-array, an invalid row or a reserved id.
 * Duplicate ids upsert (later entry replaces earlier).
 */
export function parseExtraMcpServersForWrite(raw: unknown): ExtraMcpServer[] {
  if (!Array.isArray(raw)) {
    throw new Error('mcpServers must be an array')
  }
  if (raw.length > MAX_EXTRA_MCP_SERVERS) {
    throw new Error(`at most ${MAX_EXTRA_MCP_SERVERS} MCP servers`)
  }
  const byId = new Map<string, ExtraMcpServer>()
  for (const entry of raw) {
    const parsed = extraMcpServerSchema.safeParse(entry)
    if (!parsed.success) {
      throw new Error('invalid mcpServers entry')
    }
    const id = normalizeMcpServerId(parsed.data.id)
    if (!id) throw new Error('mcp server id is empty')
    if (mcpServerIdHasDot(id)) throw new Error('mcp server id cannot contain a dot')
    if (isReservedMcpServerId(id) || isReservedMcpServerId(parsed.data.id)) {
      throw new Error(`mcp server id "${RESERVED_MCP_SERVER_ID}" is reserved`)
    }
    byId.set(id, { ...parsed.data, id })
  }
  return [...byId.values()]
}

/** Enabled extras that are safe to attach — reserved id is skipped if it slipped in. */
export function enabledExtraMcpServers(list: readonly ExtraMcpServer[]): ExtraMcpServer[] {
  return list.filter((server) => server.enabled && !isReservedMcpServerId(server.id))
}
