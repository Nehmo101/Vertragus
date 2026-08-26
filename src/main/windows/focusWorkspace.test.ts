import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  hide(): void {
    this.visible = false
    this.log.push(`hide:${this.key}`)
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
  it('hides foreign windows and restores+shows the workspace ones once', () => {
    const { log, windows, targets } = harness(['orch', 'worker', 'other-a', 'other-b'])
    windows.orch!.minimized = true

    focusWorkspaceAgents(['orch', 'worker'], { windows: () => targets })

    expect(log).toEqual([
      'hide:other-a',
      'hide:other-b',
      'restore:orch',
      'show:orch',
      'show:worker',
      'focus:orch'
    ])
    expect(log.filter((entry) => entry.startsWith('focus:'))).toHaveLength(1)
    expect(windows['other-a']!.visible).toBe(false)
    expect(windows['other-b']!.visible).toBe(false)
    expect(log.some((entry) => entry.startsWith('minimize:'))).toBe(false)
  })

  it('hides minimized foreign windows and leaves already-hidden ones untouched', () => {
    const { log, windows, targets } = harness(['mine', 'hidden', 'minimized', 'visible'])
    windows.hidden!.visible = false
    windows.minimized!.minimized = true

    focusWorkspaceAgents(['mine'], { windows: () => targets })

    expect(log).toEqual(['hide:minimized', 'hide:visible', 'show:mine', 'focus:mine'])
    expect(windows.hidden!.visible).toBe(false)
    expect(windows.hidden!.minimized).toBe(false)
    expect(windows.minimized!.visible).toBe(false)
    expect(log).not.toContain('hide:hidden')
    expect(log.some((entry) => entry.startsWith('minimize:'))).toBe(false)
  })

  it('shows workspace windows that were hidden', () => {
    const { log, windows, targets } = harness(['mine', 'foreign'])
    windows.mine!.visible = false

    focusWorkspaceAgents(['mine'], { windows: () => targets })

    expect(log).toEqual(['hide:foreign', 'show:mine', 'focus:mine'])
    expect(windows.mine!.visible).toBe(true)
  })

  it('focuses exactly once, on the first workspace window in caller order', () => {
    const { log, targets } = harness(['a', 'b', 'c', 'foreign'])

    focusWorkspaceAgents(['b', 'a', 'c'], { windows: () => targets })

    expect(log.filter((entry) => entry.startsWith('focus:'))).toEqual(['focus:b'])
    expect(log).toEqual(['hide:foreign', 'show:b', 'show:a', 'show:c', 'focus:b'])
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

    expect(log).toEqual(['hide:foreign', 'show:mine', 'focus:mine'])
  })

  it('calls beforeRestore for a minimized wanted window before restore', () => {
    const { log, windows, targets } = harness(['mine', 'other'])
    windows.mine!.minimized = true
    windows.other!.minimized = true
    const beforeRestore = vi.fn((agentId: string) => {
      log.push(`beforeRestore:${agentId}`)
    })

    focusWorkspaceAgents(['mine'], { windows: () => targets, beforeRestore })

    const hookAt = log.indexOf('beforeRestore:mine')
    const restoreAt = log.indexOf('restore:mine')
    expect(hookAt).toBeGreaterThanOrEqual(0)
    expect(restoreAt).toBeGreaterThan(hookAt)
    expect(beforeRestore).toHaveBeenCalledWith('mine')
    expect(beforeRestore).toHaveBeenCalledTimes(1)
    expect(log).not.toContain('beforeRestore:other')
    expect(log).not.toContain('restore:other')
  })

  it('suppresses hide and show so live-reflow cannot read them as a drag', () => {
    const { log, windows, targets } = harness(['mine', 'foreign'])
    windows.mine!.minimized = true
    const beforeHide = vi.fn((agentId: string) => {
      log.push(`beforeHide:${agentId}`)
    })
    const beforeShow = vi.fn((agentId: string) => {
      log.push(`beforeShow:${agentId}`)
    })

    focusWorkspaceAgents(['mine'], { windows: () => targets, beforeHide, beforeShow })

    expect(log).toEqual([
      'beforeHide:foreign',
      'hide:foreign',
      'restore:mine',
      'beforeShow:mine',
      'show:mine',
      'focus:mine'
    ])
    expect(beforeHide).not.toHaveBeenCalledWith('mine')
    expect(beforeShow).not.toHaveBeenCalledWith('foreign')
  })
})

describe('production wiring', () => {
  it('suppresses hide, restore and show on a workspace click', () => {
    const source = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    expect(source).toMatch(/beforeHide:\s*suppressMoveTracking/)
    expect(source).toMatch(/beforeRestore:\s*suppressMoveTracking/)
    expect(source).toMatch(/beforeShow:\s*suppressMoveTracking/)
    expect(source).toMatch(/layoutCliWindows\(agentIds\)/)
  })
})
