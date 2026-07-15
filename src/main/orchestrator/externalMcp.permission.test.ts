import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const directory = mkdtempSync(join(tmpdir(), 'orca-permission-mcp-'))
vi.mock('electron', () => ({ app: { getPath: () => directory } }))
vi.mock('@main/config/store', () => ({ listMcpServers: () => [] }))

import { buildSubagentMcpArgs } from './externalMcp'
import { setMcpHandle, SUBAGENT_ALLOWED_TOOLS } from './mcpHandle'

afterAll(() => {
  setMcpHandle(null)
  rmSync(directory, { recursive: true, force: true })
})

describe('Claude native permission callback launch', () => {
  it('attaches only the fixed Orca permission MCP tool to non-yolo Claude tasks', () => {
    setMcpHandle({
      url: 'http://127.0.0.1:1/mcp',
      subagentUrl: 'http://127.0.0.1:1/mcp?token=fixed',
      allowedTools: [],
      close: async () => undefined
    })
    expect(SUBAGENT_ALLOWED_TOOLS).toContain('mcp__orca-sub__permission_prompt')
    const args = buildSubagentMcpArgs('claude', 'agent-1', {
      taskId: 'task-1', engineId: 'engine-1', workspaceSessionId: 'session-1',
      permissionPrompt: true
    })
    const flag = args.indexOf('--permission-prompt-tool')
    expect(args[flag + 1]).toBe('mcp__orca-sub__permission_prompt')
    expect(args.join(' ')).not.toContain('agent.write')

    const yoloArgs = buildSubagentMcpArgs('claude', 'agent-2', {
      taskId: 'task-2', permissionPrompt: false
    })
    expect(yoloArgs).not.toContain('--permission-prompt-tool')
    expect(yoloArgs.join(' ')).not.toContain('mcp__orca-sub__permission_prompt')
  })
})
