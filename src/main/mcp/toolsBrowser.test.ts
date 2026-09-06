import { describe, expect, it, vi } from 'vitest'
import { BrowserBridge } from './browserBridge'
import { BROWSER_TOOL_NAMES, registerBrowserTools } from './toolsBrowser'
import { callTool, captureTools } from './testing'

describe('browser tools', () => {
  it('registers exactly the documented tools', () => {
    const bridge = new BrowserBridge({ token: 'a'.repeat(32) })
    const tools = captureTools((server) => registerBrowserTools(server, bridge))
    expect([...tools.keys()].sort()).toEqual([...BROWSER_TOOL_NAMES].sort())
    for (const tool of tools.values()) expect(tool.description?.length ?? 0).toBeGreaterThan(40)
  })

  it('browser_status reports disconnected without erroring', async () => {
    const bridge = new BrowserBridge({ token: 'a'.repeat(32) })
    const tools = captureTools((server) => registerBrowserTools(server, bridge))
    const result = await callTool(tools, 'browser_status')
    expect(result.isError).toBe(false)
    expect(result.json.connected).toBe(false)
    expect(String(result.json.note)).toMatch(/not connected/i)
  })

  it('driving tools error with browser_disconnected when nothing is paired', async () => {
    const bridge = new BrowserBridge({ token: 'a'.repeat(32) })
    const tools = captureTools((server) => registerBrowserTools(server, bridge))
    for (const name of [
      'browser_tabs',
      'browser_snapshot',
      'browser_screenshot'
    ] as const) {
      const result = await callTool(tools, name)
      expect(result.isError, name).toBe(true)
      expect(result.json.error, name).toBe('browser_disconnected')
    }
  })
})

it('returns screenshots as native MCP images', async () => {
  const bridge = new BrowserBridge()
  vi.spyOn(bridge, 'call').mockResolvedValue({ mimeType: 'image/png', data: 'cGljdHVyZQ==' })
  try {
    const tools = captureTools((server) => registerBrowserTools(server, bridge))
    const result = await tools.get('browser_screenshot')!.handler({ tabId: 1 })
    expect(result.content).toEqual([{ type: 'image', mimeType: 'image/png', data: 'cGljdHVyZQ==' }])
  } finally { bridge.close() }
})

it.each([
  ['browser_navigate', { url: 'https://example.test' }, 'navigate', { url: 'https://example.test' }],
  ['browser_navigate', { url: 'https://example.test', tabId: 7 }, 'navigate', { url: 'https://example.test', tabId: 7 }],
  ['browser_snapshot', {}, 'snapshot', {}],
  ['browser_snapshot', { tabId: 7 }, 'snapshot', { tabId: 7 }],
  ['browser_click', { ref: 'document-1-e1' }, 'click', { ref: 'document-1-e1' }],
  ['browser_click', { ref: 'document-1-e1', tabId: 7 }, 'click', { ref: 'document-1-e1', tabId: 7 }],
  ['browser_fill', { ref: 'document-1-e1', text: 'hello' }, 'fill', { ref: 'document-1-e1', text: 'hello' }],
  ['browser_fill', { ref: 'document-1-e1', text: 'hello', tabId: 7, submit: true }, 'fill', { ref: 'document-1-e1', text: 'hello', tabId: 7, submit: true }],
  ['browser_press', { key: 'Enter' }, 'press', { key: 'Enter' }],
  ['browser_press', { key: 'Tab', tabId: 7 }, 'press', { key: 'Tab', tabId: 7 }],
  ['browser_tabs', {}, 'tabs', {}]
] as const)('%s forwards the exact browser action through the task owner', async (name, args, command, params) => {
  const bridge = new BrowserBridge()
  const call = vi.spyOn(bridge, 'callOwned').mockResolvedValue({ ok: true })
  try {
    const tools = captureTools((server) => registerBrowserTools(server, bridge, 'workspace:alice'))
    expect((await callTool(tools, name, args)).json).toEqual({ ok: true })
    expect(call).toHaveBeenCalledWith('workspace:alice', command, params)
  } finally { bridge.close() }
})

it.each([
  ['browser_navigate', { url: 'https://example.test' }],
  ['browser_click', { ref: 'stale' }],
  ['browser_fill', { ref: 'stale', text: 'hello' }],
  ['browser_press', { key: 'ArrowDown' }]
] as const)('%s preserves an extension rejection as a tool error', async (name, args) => {
  const bridge = new BrowserBridge()
  vi.spyOn(bridge, 'call').mockRejectedValue(new Error('stale ref or unsupported action'))
  try {
    const tools = captureTools((server) => registerBrowserTools(server, bridge))
    expect((await callTool(tools, name, args)).json).toMatchObject({ error: 'browser_error', message: 'stale ref or unsupported action' })
  } finally { bridge.close() }
})

it('reports timeout and named disconnect without claiming the action succeeded', async () => {
  const bridge = new BrowserBridge()
  const call = vi.spyOn(bridge, 'call')
  const tools = captureTools((server) => registerBrowserTools(server, bridge))
  try {
    call.mockRejectedValueOnce(new Error('browser_timeout'))
    expect((await callTool(tools, 'browser_snapshot')).json.error).toBe('browser_timeout')
    call.mockRejectedValueOnce(Object.assign(new Error('socket closed'), { name: 'browser_disconnected' }))
    expect((await callTool(tools, 'browser_tabs')).json.error).toBe('browser_disconnected')
    call.mockRejectedValueOnce('extension failure')
    expect((await callTool(tools, 'browser_tabs')).json.message).toBe('extension failure')
  } finally { bridge.close() }
})

it('rejects stale sessions both before dispatch and after an outstanding response', async () => {
  const bridge = new BrowserBridge()
  let active = false
  const call = vi.spyOn(bridge, 'callOwned')
  const tools = captureTools((server) => registerBrowserTools(server, bridge, 'alice', () => active))
  try {
    expect((await callTool(tools, 'browser_snapshot', { tabId: 1 })).isError).toBe(true)
    expect(call).not.toHaveBeenCalled()
    expect((await callTool(tools, 'browser_release')).json.error).toBe('browser_session_replaced')
    active = true
    call.mockImplementationOnce(async () => { active = false; return { nodes: [] } })
    expect((await callTool(tools, 'browser_snapshot', { tabId: 1 })).json.message).toBe('browser_session_replaced')
    active = true
    const release = vi.spyOn(bridge, 'releaseOwner')
    expect((await callTool(tools, 'browser_release')).json.ok).toBe(true)
    expect(release).toHaveBeenCalledWith('alice')
  } finally { bridge.close() }
})

it.each([undefined, { mimeType: 'image/png' }, { data: 'YWJj', mimeType: 'text/html' }])('refuses malformed screenshot payload %j', async (payload) => {
  const bridge = new BrowserBridge()
  vi.spyOn(bridge, 'call').mockResolvedValue(payload)
  try {
    const tools = captureTools((server) => registerBrowserTools(server, bridge))
    expect((await callTool(tools, 'browser_screenshot')).json.message).toBe('Invalid screenshot')
  } finally { bridge.close() }
})

it('reports connected status without disclosing the pairing secret and allows an unowned release', async () => {
  const bridge = new BrowserBridge()
  vi.spyOn(bridge, 'status').mockReturnValue({ ...bridge.status(), connected: true, clients: 1 })
  try {
    const tools = captureTools((server) => registerBrowserTools(server, bridge))
    const result = await callTool(tools, 'browser_status')
    expect(result.json).toMatchObject({ connected: true, clients: 1 })
    expect(result.json).not.toHaveProperty('token')
    expect((await callTool(tools, 'browser_release')).json.ok).toBe(true)
  } finally { bridge.close() }
})
