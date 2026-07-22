/**
 * Targeted fanout for agent PTY chunks (Audit A6).
 *
 * Previously every agent's terminal chunk was broadcast to every window, and
 * each renderer discarded the chunks whose id did not match a terminal it
 * shows. The only windows that actually render an agent's terminal are the
 * main window (which shows every agent) and that agent's popped-out pane
 * window(s). The voice overlay and other agents' panes only ever threw the
 * chunk away — this selects the real recipients so those wasted IPC sends and
 * renderer-side filters disappear. Pure and electron-free for unit testing.
 */
export interface FanoutWindow {
  isDestroyed(): boolean
}

export function agentDataTargetWindows<T extends FanoutWindow>(
  agentId: string,
  main: T | null,
  panesById: ReadonlyMap<string, ReadonlySet<T>>
): T[] {
  const targets: T[] = []
  if (main && !main.isDestroyed()) targets.push(main)
  const panes = panesById.get(agentId)
  if (panes) {
    for (const win of panes) {
      if (win !== main && !win.isDestroyed()) targets.push(win)
    }
  }
  return targets
}
