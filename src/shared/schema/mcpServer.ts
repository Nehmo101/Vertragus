/**
 * Extra MCP servers the user configures globally (Settings), attached next to
 * the built-in Vertragus server on every spawn whose provider `mcp.kind` is
 * not `none`.
 *
 * Pure data + zod only (no Node imports) so main, preload and renderer share
 * one source of truth. Fail-soft on read, fail-closed on write.
 */
import { z } from 'zod'
import { normalizeProviderId } from './provider'

/** Built-in Vertragus MCP namespace — extra servers may not reuse this id. */
export const RESERVED_MCP_SERVER_ID = 'vertragus'

const MAX_ID_LENGTH = 64
const MAX_LABEL_LENGTH = 80
const MAX_COMMAND_LENGTH = 200
const MAX_URL_LENGTH = 400
const MAX_ARG_LENGTH = 400
const MAX_ARGS = 64
const MAX_MAP_KEY_LENGTH = 200
const MAX_MAP_VALUE_LENGTH = 2000
const MAX_MAP_ENTRIES = 32

/** Same alphabet as provider ids: lowercase `[a-z0-9._-]`. */
export function normalizeMcpServerId(id: string): string {
  return normalizeProviderId(id)
}

const extraMcpMapSchema = z
  .record(z.string().trim().min(1).max(MAX_MAP_KEY_LENGTH), z.string().max(MAX_MAP_VALUE_LENGTH))
  .refine((value) => Object.keys(value).length <= MAX_MAP_ENTRIES, {
    message: 'too many entries'
  })
  .optional()

const extraMcpServerBase = {
  id: z.string().trim().min(1).max(MAX_ID_LENGTH),
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
  if (!id || id === RESERVED_MCP_SERVER_ID) return undefined
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
  const byId = new Map<string, ExtraMcpServer>()
  for (const entry of raw) {
    const parsed = extraMcpServerSchema.safeParse(entry)
    if (!parsed.success) {
      throw new Error('invalid mcpServers entry')
    }
    const id = normalizeMcpServerId(parsed.data.id)
    if (!id) throw new Error('mcp server id is empty')
    if (id === RESERVED_MCP_SERVER_ID) {
      throw new Error(`mcp server id "${RESERVED_MCP_SERVER_ID}" is reserved`)
    }
    byId.set(id, { ...parsed.data, id })
  }
  return [...byId.values()]
}

/** Enabled extras that are safe to attach — reserved id is skipped if it slipped in. */
export function enabledExtraMcpServers(list: readonly ExtraMcpServer[]): ExtraMcpServer[] {
  return list.filter((server) => server.enabled && server.id !== RESERVED_MCP_SERVER_ID)
}
