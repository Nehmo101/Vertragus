import { describe, expect, it } from 'vitest'
import { agentDataTargetWindows, type FanoutWindow } from './agentDataFanout'

class FakeWindow implements FanoutWindow {
  constructor(
    readonly name: string,
    private destroyed = false
  ) {}
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
  }
}

describe('agentDataTargetWindows (A6 targeted PTY fanout)', () => {
  it('always includes the live main window', () => {
    const main = new FakeWindow('main')
    expect(agentDataTargetWindows('a1', main, new Map())).toEqual([main])
  })

  it('adds only the pane windows of the matching agent', () => {
    const main = new FakeWindow('main')
    const paneA = new FakeWindow('paneA')
    const paneB = new FakeWindow('paneB')
    const panes = new Map<string, Set<FakeWindow>>([
      ['a1', new Set([paneA])],
      ['a2', new Set([paneB])]
    ])
    // a1's chunk reaches main + a1's pane, never a2's pane.
    expect(agentDataTargetWindows('a1', main, panes)).toEqual([main, paneA])
    expect(agentDataTargetWindows('a2', main, panes)).toEqual([main, paneB])
  })

  it('reaches an agent pane even with no main window (e.g. minimized/closed main)', () => {
    const pane = new FakeWindow('pane')
    const panes = new Map([['a1', new Set([pane])]])
    expect(agentDataTargetWindows('a1', null, panes)).toEqual([pane])
  })

  it('skips destroyed windows and never double-counts the main window', () => {
    const main = new FakeWindow('main')
    const deadPane = new FakeWindow('deadPane', true)
    const panes = new Map<string, Set<FakeWindow>>([['a1', new Set([main, deadPane])]])
    // main present in the pane set must not be emitted twice; dead pane dropped.
    expect(agentDataTargetWindows('a1', main, panes)).toEqual([main])
  })

  it('returns nothing when no window wants the chunk', () => {
    expect(agentDataTargetWindows('ghost', null, new Map())).toEqual([])
  })
})
