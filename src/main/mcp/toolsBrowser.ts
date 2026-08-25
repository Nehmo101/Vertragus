/**
 * Browser tools a subagent (worker or helper) gets. They talk to the user's
 * real Chromium through the pairing extension — not a fresh Playwright
 * session — so logged-in apps can be tested as the user sees them.
 *
 * Orchestrators and leads do not get these tools: they delegate. A
 * disconnected extension is a tool error, never a silent no-op.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { toolError, toolJson, type ToolText } from './types'
import type { BrowserBridge } from './browserBridge'

export const BROWSER_TOOL_NAMES = [
  'browser_status',
  'browser_tabs',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_fill',
  'browser_press',
  'browser_screenshot'
] as const
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number]

const DISCONNECTED_NOTE =
  'The Vertragus Chromium extension is not connected. Pair it from Settings → Browser extension, then retry.'

function asError(error: unknown): ToolText {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'browser_disconnected' || (error instanceof Error && error.name === 'browser_disconnected')) {
    return toolError({ error: 'browser_disconnected', note: DISCONNECTED_NOTE })
  }
  if (message === 'browser_timeout') {
    return toolError({
      error: 'browser_timeout',
      note: 'The extension did not answer in time. Check the tab is still open and retry.'
    })
  }
  return toolError({ error: 'browser_error', message })
}

export function registerBrowserTools(server: McpServer, bridge: BrowserBridge): void {
  server.registerTool(
    'browser_status',
    {
      description:
        'Whether the Vertragus Chromium extension is paired and how many clients are connected. ' +
        'Call this before other browser_* tools; disconnected means you cannot test a live web app.',
      inputSchema: {}
    },
    async (): Promise<ToolText> => {
      const status = bridge.status()
      return toolJson({
        connected: status.connected,
        clients: status.clients,
        port: status.port,
        note: status.connected
          ? 'Extension connected. Use browser_tabs then browser_snapshot / browser_click / browser_fill.'
          : DISCONNECTED_NOTE
      })
    }
  )

  server.registerTool(
    'browser_tabs',
    {
      description: 'List the open Chromium tabs the extension can drive (id, title, url, active).',
      inputSchema: {}
    },
    async (): Promise<ToolText> => {
      try {
        const result = await bridge.call('tabs')
        return toolJson(result)
      } catch (error) {
        return asError(error)
      }
    }
  )

  server.registerTool(
    'browser_navigate',
    {
      description:
        'Navigate a tab to a URL. Omit tabId to use the active tab (or create one). Returns the tab after load.',
      inputSchema: {
        url: z.string().min(1).max(4_000).describe('http(s) URL to open'),
        tabId: z.number().int().positive().optional().describe('Existing tab to reuse')
      }
    },
    async ({ url, tabId }): Promise<ToolText> => {
      try {
        const result = await bridge.call('navigate', { url, ...(tabId !== undefined ? { tabId } : {}) })
        return toolJson(result)
      } catch (error) {
        return asError(error)
      }
    }
  )

  server.registerTool(
    'browser_snapshot',
    {
      description:
        'Accessibility-style snapshot of a tab: a tree of visible interactive elements with refs (e1, e2, …). ' +
        'Pass those refs to browser_click / browser_fill. Take a fresh snapshot after navigation or a big DOM change.',
      inputSchema: {
        tabId: z.number().int().positive().optional()
      }
    },
    async ({ tabId }): Promise<ToolText> => {
      try {
        const result = await bridge.call('snapshot', tabId !== undefined ? { tabId } : {})
        return toolJson(result)
      } catch (error) {
        return asError(error)
      }
    }
  )

  server.registerTool(
    'browser_click',
    {
      description: 'Click the element with this snapshot ref in the given (or active) tab.',
      inputSchema: {
        ref: z.string().min(1).max(40).describe('Ref from the last browser_snapshot, e.g. e12'),
        tabId: z.number().int().positive().optional()
      }
    },
    async ({ ref, tabId }): Promise<ToolText> => {
      try {
        const result = await bridge.call('click', { ref, ...(tabId !== undefined ? { tabId } : {}) })
        return toolJson(result)
      } catch (error) {
        return asError(error)
      }
    }
  )

  server.registerTool(
    'browser_fill',
    {
      description: 'Type into the input/textarea with this snapshot ref. Optionally submit with Enter.',
      inputSchema: {
        ref: z.string().min(1).max(40),
        text: z.string().max(8_000),
        submit: z.boolean().optional().describe('Press Enter after filling'),
        tabId: z.number().int().positive().optional()
      }
    },
    async ({ ref, text, submit, tabId }): Promise<ToolText> => {
      try {
        const result = await bridge.call('fill', {
          ref,
          text,
          ...(submit ? { submit: true } : {}),
          ...(tabId !== undefined ? { tabId } : {})
        })
        return toolJson(result)
      } catch (error) {
        return asError(error)
      }
    }
  )

  server.registerTool(
    'browser_press',
    {
      description: 'Press a key in the active element of the tab (Enter, Escape, Tab, ArrowDown, …).',
      inputSchema: {
        key: z.string().min(1).max(40),
        tabId: z.number().int().positive().optional()
      }
    },
    async ({ key, tabId }): Promise<ToolText> => {
      try {
        const result = await bridge.call('press', { key, ...(tabId !== undefined ? { tabId } : {}) })
        return toolJson(result)
      } catch (error) {
        return asError(error)
      }
    }
  )

  server.registerTool(
    'browser_screenshot',
    {
      description:
        'PNG screenshot of the visible tab, returned as base64 in the JSON result (data + mimeType). ' +
        'Use after a click or navigation to verify what the user would see.',
      inputSchema: {
        tabId: z.number().int().positive().optional()
      }
    },
    async ({ tabId }): Promise<ToolText> => {
      try {
        const result = await bridge.call('screenshot', tabId !== undefined ? { tabId } : {})
        return toolJson(result)
      } catch (error) {
        return asError(error)
      }
    }
  )
}
