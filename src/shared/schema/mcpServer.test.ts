import { describe, expect, it } from 'vitest'
import {
  enabledExtraMcpServers,
  extraMcpServerSchema,
  isReservedMcpServerId,
  MAX_EXTRA_MCP_SERVERS,
  normalizeMcpServerId,
  parseExtraMcpServers,
  parseExtraMcpServersForWrite,
  RESERVED_MCP_SERVER_ID,
  type ExtraMcpServer
} from './mcpServer'

const stdio = {
  id: 'github',
  label: 'GitHub',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'secret' }
}

const http = {
  id: 'linear',
  label: 'Linear',
  transport: 'http' as const,
  url: 'https://mcp.linear.app/mcp',
  headers: { Authorization: 'Bearer x' }
}

describe('extraMcpServerSchema', () => {
  it('round-trips a stdio server and fills defaults', () => {
    const parsed = extraMcpServerSchema.parse({
      id: 'github',
      label: 'GitHub',
      transport: 'stdio',
      command: 'npx'
    })
    expect(parsed).toEqual({
      id: 'github',
      label: 'GitHub',
      transport: 'stdio',
      command: 'npx',
      args: [],
      enabled: true
    })
  })

  it('round-trips an http server', () => {
    const parsed = extraMcpServerSchema.parse(http)
    expect(parsed).toMatchObject({
      id: 'linear',
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer x' },
      enabled: true
    })
  })

  it('rejects an empty command and a bad url', () => {
    expect(
      extraMcpServerSchema.safeParse({ ...stdio, command: '  ' }).success
    ).toBe(false)
    expect(
      extraMcpServerSchema.safeParse({ ...http, url: 'not-a-url' }).success
    ).toBe(false)
  })

  it('rejects an unknown field (strict)', () => {
    expect(extraMcpServerSchema.safeParse({ ...stdio, extra: true }).success).toBe(false)
  })

  it('rejects a dotted id — Codex would treat it as TOML nesting', () => {
    expect(extraMcpServerSchema.safeParse({ ...stdio, id: 'github.api' }).success).toBe(false)
  })
})

describe('normalizeMcpServerId', () => {
  it('uses the same rules as provider ids', () => {
    expect(normalizeMcpServerId('  GitHub Server!  ')).toBe('github-server')
    expect(normalizeMcpServerId('linear')).toBe('linear')
  })
})

describe('isReservedMcpServerId', () => {
  it('matches vertragus case-insensitively', () => {
    expect(isReservedMcpServerId('vertragus')).toBe(true)
    expect(isReservedMcpServerId('Vertragus')).toBe(true)
    expect(isReservedMcpServerId('VERTRAGUS')).toBe(true)
    expect(isReservedMcpServerId('  vertragus  ')).toBe(true)
    expect(isReservedMcpServerId('github')).toBe(false)
    expect(isReservedMcpServerId('vertragus-extra')).toBe(false)
  })
})

describe('parseExtraMcpServers', () => {
  it('keeps a valid stdio + http pair', () => {
    const parsed = parseExtraMcpServers([stdio, http])
    expect(parsed.map((server) => server.id)).toEqual(['github', 'linear'])
    expect(parsed[0]).toMatchObject({ transport: 'stdio', command: 'npx', enabled: true })
    expect(parsed[1]).toMatchObject({ transport: 'http', url: http.url })
  })

  it('returns [] for a non-array', () => {
    expect(parseExtraMcpServers(undefined)).toEqual([])
    expect(parseExtraMcpServers({ id: 'github' })).toEqual([])
    expect(parseExtraMcpServers('github')).toEqual([])
  })

  it('drops invalid, duplicate, reserved, empty-command and bad-url rows; first id wins', () => {
    const parsed = parseExtraMcpServers([
      stdio,
      { ...stdio, label: 'Second GitHub' },
      { id: RESERVED_MCP_SERVER_ID, label: 'Built-in', transport: 'http', url: 'http://127.0.0.1/mcp' },
      { id: 'broken' },
      { ...stdio, id: 'empty-cmd', command: '  ' },
      { ...http, id: 'bad-url', url: 'linear' },
      http
    ])
    expect(parsed.map((server) => server.id)).toEqual(['github', 'linear'])
    expect(parsed[0]!.label).toBe('GitHub')
  })

  it('normalizes ids on read', () => {
    const parsed = parseExtraMcpServers([{ ...stdio, id: '  GitHub  ' }])
    expect(parsed[0]!.id).toBe('github')
  })

  it('drops github.api on read', () => {
    expect(parseExtraMcpServers([{ ...stdio, id: 'github.api' }])).toEqual([])
  })

  it('drops VERTRAGUS on read (reserved, case-insensitive)', () => {
    expect(parseExtraMcpServers([{ ...stdio, id: 'VERTRAGUS' }])).toEqual([])
  })

  it('caps the list at MAX_EXTRA_MCP_SERVERS', () => {
    const many = Array.from({ length: MAX_EXTRA_MCP_SERVERS + 3 }, (_, index) => ({
      ...stdio,
      id: `s${index}`,
      label: `S${index}`
    }))
    expect(parseExtraMcpServers(many)).toHaveLength(MAX_EXTRA_MCP_SERVERS)
  })
})

describe('parseExtraMcpServersForWrite', () => {
  it('upserts by id and normalizes', () => {
    const parsed = parseExtraMcpServersForWrite([
      stdio,
      { ...stdio, id: 'GITHUB', label: 'GitHub (updated)' }
    ])
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.label).toBe('GitHub (updated)')
    expect(parsed[0]!.id).toBe('github')
  })

  it('rejects a reserved id, a non-array and an invalid row', () => {
    expect(() =>
      parseExtraMcpServersForWrite([
        { id: RESERVED_MCP_SERVER_ID, label: 'X', transport: 'stdio', command: 'npx' }
      ])
    ).toThrow(/reserved/)
    expect(() => parseExtraMcpServersForWrite({ id: 'github' })).toThrow(/array/)
    expect(() => parseExtraMcpServersForWrite([{ id: 'x' }])).toThrow(/invalid/)
    expect(() => parseExtraMcpServersForWrite([{ ...stdio, id: 'github.api' }])).toThrow()
  })
})

describe('enabledExtraMcpServers', () => {
  it('keeps enabled extras and skips disabled and reserved ids', () => {
    const github = extraMcpServerSchema.parse(stdio)
    const off = extraMcpServerSchema.parse({ ...http, enabled: false })
    const reserved = { ...github, id: RESERVED_MCP_SERVER_ID } as ExtraMcpServer
    expect(enabledExtraMcpServers([github, off, reserved]).map((server) => server.id)).toEqual([
      'github'
    ])
  })
})
