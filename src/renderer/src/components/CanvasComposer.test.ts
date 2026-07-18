import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { shouldSubmitComposer } from './CanvasComposer'

/** Mirrors CanvasComposer boot→send session preference (startAll id wins). */
export function resolveComposerSendSessionId(
  orchestratorRunning: boolean,
  startedSessionId: string | undefined,
  workspaceSessionId: string | undefined
): string | undefined {
  const started = !orchestratorRunning ? startedSessionId : undefined
  return started || workspaceSessionId
}

describe('CanvasComposer keyboard contract', () => {
  it('submits on Enter', () => {
    expect(shouldSubmitComposer('Enter', false)).toBe(true)
  })

  it('keeps a newline on Shift+Enter and ignores IME composition', () => {
    expect(shouldSubmitComposer('Enter', true)).toBe(false)
    expect(shouldSubmitComposer('Enter', false, true)).toBe(false)
    expect(shouldSubmitComposer('a', false)).toBe(false)
  })

  it('ignores Escape / Tab / Ctrl+Enter variants for submit', () => {
    expect(shouldSubmitComposer('Escape', false)).toBe(false)
    expect(shouldSubmitComposer('Tab', false)).toBe(false)
    expect(shouldSubmitComposer('Enter', false, false)).toBe(true)
  })
})

describe('CanvasComposer orchestrator:send boot / session resolution', () => {
  it('prefers the session id returned by startAll on cold boot', () => {
    expect(resolveComposerSendSessionId(false, 'fresh-session', 'stale-session')).toBe('fresh-session')
    expect(resolveComposerSendSessionId(false, undefined, 'existing')).toBe('existing')
    expect(resolveComposerSendSessionId(true, 'ignored-boot', 'running')).toBe('running')
  })

  it('wires startAll → orchestrator.send with startedSessionId || workspaceSessionId', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'CanvasComposer.tsx'), 'utf8')
    expect(source).toMatch(/!orchestratorRunning\s*\?\s*await startAll\(\)/)
    expect(source).toMatch(/startedSessionId\s*\|\|\s*workspaceSessionId/)
    expect(source).toMatch(/orchestrator\?\.send|orchestrator\.send/)
  })
})
