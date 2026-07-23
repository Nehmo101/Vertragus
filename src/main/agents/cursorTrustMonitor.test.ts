import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CursorTrustMonitor, type CursorTrustHost } from './cursorTrustMonitor'

function makeHost(overrides: Partial<CursorTrustHost> = {}): {
  host: CursorTrustHost
  writes: string[]
  events: Array<{ text: string; tone: string }>
  failures: string[]
  setTail(tail: string): void
} {
  const writes: string[] = []
  const events: Array<{ text: string; tone: string }> = []
  const failures: string[] = []
  let tail = ''
  const host: CursorTrustHost = {
    isPresent: () => true,
    hasPty: () => true,
    writePty: (_id, data) => {
      writes.push(data)
    },
    bufferTail: () => tail,
    trustView: () => ({
      name: 'Caronte',
      provider: 'cursor',
      workingDir: '/repo/.vertragus-worktrees/s/a',
      worktree: '/repo/.vertragus-worktrees/s/a',
      interactiveUsed: false
    }),
    emitEvent: (_id, text, tone) => {
      events.push({ text, tone })
    },
    failTrustStuckAgent: (_id, message) => {
      failures.push(message)
    },
    ...overrides
  }
  return { host, writes, events, failures, setTail: (value) => { tail = value } }
}

const TRUST_PROMPT = [
  'Do you trust the contents of this workspace?',
  '/repo/.vertragus-worktrees/s/a',
  '[a] Trust this workspace',
  '[d] Do not trust'
].join('\n')

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('CursorTrustMonitor', () => {
  it('confirms the trust dialog once for a managed worktree', () => {
    const { host, writes, events, setTail } = makeHost()
    const monitor = new CursorTrustMonitor(host)
    setTail(TRUST_PROMPT)
    monitor.autoTrust('a1')
    expect(writes).toEqual(['a\r'])
    expect(events[0]?.tone).toBe('dispatch')
    // A second scan with the flag set must not re-send.
    monitor.autoTrust('a1')
    expect(writes).toEqual(['a\r'])
  })

  it('nudges once and then fails a stuck trust confirmation via the host', () => {
    const { host, writes, failures, setTail } = makeHost()
    const monitor = new CursorTrustMonitor(host)
    setTail(TRUST_PROMPT)
    monitor.autoTrust('a1')
    setTail('Trusting workspace...')
    monitor.monitor('a1')
    vi.advanceTimersByTime(8_000)
    expect(writes).toEqual(['a\r', '\r'])
    expect(failures).toEqual([])
    vi.advanceTimersByTime(8_000)
    expect(failures).toEqual(['Caronte - Cursor Workspace-Trust fehlgeschlagen'])
  })

  it('skips timer callbacks for reassigned or removed agents', () => {
    const { host, failures, setTail } = makeHost({ hasPty: () => false })
    const monitor = new CursorTrustMonitor(host)
    setTail(TRUST_PROMPT)
    monitor.autoTrust('a1')
    monitor.monitor('a1')
    vi.advanceTimersByTime(20_000)
    expect(failures).toEqual([])
  })

  it('does nothing for non-cursor agents', () => {
    const { host, writes, setTail } = makeHost({
      trustView: () => ({
        name: 'X',
        provider: 'codex',
        workingDir: '/w',
        worktree: undefined,
        interactiveUsed: false
      })
    })
    const monitor = new CursorTrustMonitor(host)
    setTail(TRUST_PROMPT)
    monitor.autoTrust('a1')
    expect(writes).toEqual([])
  })
})
