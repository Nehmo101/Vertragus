import { describe, expect, it } from 'vitest'
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
