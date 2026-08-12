import { describe, expect, it, vi } from 'vitest'

vi.mock('./cliWindow', () => ({ listCliWindows: () => [] }))

import {
  focusWorkspaceAgents,
  type FocusWorkspaceTarget
} from './focusWorkspace'

class FakeWindow {
  visible = true
  destroyed = false
  minimized = false
  readonly log: string[]

  constructor(
    readonly key: string,
    log: string[]
  ) {
    this.log = log
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  isVisible(): boolean {
    return this.visible
  }
  isMinimized(): boolean {
    return this.minimized
  }
  minimize(): void {
    this.minimized = true
    this.log.push(`minimize:${this.key}`)
  }
  restore(): void {
    this.minimized = false
    this.log.push(`restore:${this.key}`)
  }
  showInactive(): void {
    this.visible = true
    this.log.push(`show:${this.key}`)
  }
  focus(): void {
    this.log.push(`focus:${this.key}`)
  }
}

function harness(agentIds: string[]): {
  log: string[]
  windows: Record<string, FakeWindow>
  targets: FocusWorkspaceTarget[]
} {
  const log: string[] = []
  const windows: Record<string, FakeWindow> = {}
  const targets = agentIds.map((agentId) => {
    const window = new FakeWindow(agentId, log)
    windows[agentId] = window
    return { agentId, window }
  })
  return { log, windows, targets }
}

describe('focusWorkspaceAgents', () => {
  it('minimizes foreign windows and restores+shows the workspace ones once', () => {
    const { log, windows, targets } = harness(['orch', 'worker', 'other-a', 'other-b'])
    windows.orch!.minimized = true

    focusWorkspaceAgents(['orch', 'worker'], { windows: () => targets })

    expect(log).toEqual([
      'minimize:other-a',
      'minimize:other-b',
      'restore:orch',
      'show:orch',
      'show:worker',
      'focus:orch'
    ])
    expect(log.filter((entry) => entry.startsWith('focus:'))).toHaveLength(1)
    expect(windows['other-a']!.minimized).toBe(true)
    expect(windows['other-b']!.minimized).toBe(true)
  })

  it('leaves hidden and already-minimized foreign windows alone', () => {
    const { log, windows, targets } = harness(['mine', 'hidden', 'minimized', 'visible'])
    windows.hidden!.visible = false
    windows.minimized!.minimized = true

    focusWorkspaceAgents(['mine'], { windows: () => targets })

    expect(log).toEqual(['minimize:visible', 'show:mine', 'focus:mine'])
    expect(windows.hidden!.visible).toBe(false)
    expect(windows.hidden!.minimized).toBe(false)
    expect(windows.minimized!.minimized).toBe(true)
    expect(log).not.toContain('minimize:hidden')
    expect(log).not.toContain('minimize:minimized')
  })

  it('focuses exactly once, on the first workspace window in caller order', () => {
    const { log, targets } = harness(['a', 'b', 'c', 'foreign'])

    focusWorkspaceAgents(['b', 'a', 'c'], { windows: () => targets })

    expect(log.filter((entry) => entry.startsWith('focus:'))).toEqual(['focus:b'])
    expect(log).toEqual([
      'minimize:foreign',
      'show:b',
      'show:a',
      'show:c',
      'focus:b'
    ])
  })

  it('is a no-op for an empty agent id list (unknown workspace)', () => {
    const { log, targets } = harness(['a', 'b'])

    focusWorkspaceAgents([], { windows: () => targets })

    expect(log).toEqual([])
  })

  it('skips destroyed windows and shrugs at missing agent windows', () => {
    const { log, windows, targets } = harness(['mine', 'gone', 'foreign'])
    windows.gone!.destroyed = true

    focusWorkspaceAgents(['mine', 'ghost', 'gone'], { windows: () => targets })

    expect(log).toEqual(['minimize:foreign', 'show:mine', 'focus:mine'])
  })
})
