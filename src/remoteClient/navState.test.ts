import { describe, expect, it } from 'vitest'
import {
  answerDraftKey,
  composerDraftKey,
  connectionClass,
  connectionLabel,
  connectionState,
  EXPANSION_KEY,
  historyAction,
  parseExpansionState,
  pruneExpansionState,
  readExpansionState,
  readStored,
  scrollRestoreTarget,
  shouldShowBackToTop,
  writeExpansionState,
  writeStored,
  type StorageLike
} from './navState'

function memoryStorage(seed: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    }
  }
}

/** Private mode: the object exists but every operation throws. */
const hostileStorage: StorageLike = {
  getItem() {
    throw new Error('SecurityError')
  },
  setItem() {
    throw new Error('QuotaExceededError')
  }
}

describe('guarded storage', () => {
  it('reads and writes through a working storage', () => {
    const storage = memoryStorage()
    writeStored('k', 'v', storage)
    expect(readStored('k', storage)).toBe('v')
    expect(readStored('missing', storage)).toBeUndefined()
  })

  it('survives a storage that throws and one that is absent', () => {
    expect(() => writeStored('k', 'v', hostileStorage)).not.toThrow()
    expect(readStored('k', hostileStorage)).toBeUndefined()
    expect(readStored('k', undefined)).toBeUndefined()
    expect(() => writeStored('k', 'v', undefined)).not.toThrow()
  })
})

describe('expansion state', () => {
  it('round-trips the map through storage', () => {
    const storage = memoryStorage()
    writeExpansionState({ w1: true, w2: false }, ['w1', 'w2'], storage)
    expect(readExpansionState(storage)).toEqual({ w1: true, w2: false })
    expect(storage.data.has(EXPANSION_KEY)).toBe(true)
  })

  it('drops decisions about workspaces that no longer exist', () => {
    expect(pruneExpansionState({ live: true, gone: false }, ['live'])).toEqual({ live: true })
    const storage = memoryStorage()
    writeExpansionState({ live: false, gone: true }, ['live'], storage)
    expect(readExpansionState(storage)).toEqual({ live: false })
  })

  it('treats junk, arrays and non-booleans as no memory at all', () => {
    expect(parseExpansionState(undefined)).toEqual({})
    expect(parseExpansionState('not json')).toEqual({})
    expect(parseExpansionState('[1,2]')).toEqual({})
    expect(parseExpansionState('null')).toEqual({})
    expect(parseExpansionState('{"a":true,"b":"yes","c":1}')).toEqual({ a: true })
    expect(readExpansionState(hostileStorage)).toEqual({})
  })
})

describe('draft keys', () => {
  it('namespaces every field so two drafts cannot collide', () => {
    expect(composerDraftKey('w1')).toBe('composer:w1')
    expect(answerDraftKey('w1:user:q-1')).toBe('answer:w1:user:q-1')
    expect(new Set([composerDraftKey('x'), answerDraftKey('x')]).size).toBe(2)
  })
})

describe('the terminal history entry', () => {
  it('pushes once on open and goes back once on an in-app close', () => {
    expect(historyAction(null, 'agent-1', false)).toBe('push')
    expect(historyAction('agent-1', null, true)).toBe('back')
  })

  it('does not walk out of the app after a hardware back', () => {
    // popstate cleared `pushed` before the state change reached this check.
    expect(historyAction('agent-1', null, false)).toBe('none')
  })

  it('never pushes twice for one open terminal', () => {
    expect(historyAction(null, 'agent-1', true)).toBe('none')
    expect(historyAction('agent-1', 'agent-2', true)).toBe('none')
    expect(historyAction(null, null, false)).toBe('none')
  })
})

describe('scroll bookkeeping', () => {
  it('stays out of the way when the document never moved', () => {
    expect(scrollRestoreTarget(820, 820)).toBeUndefined()
    expect(scrollRestoreTarget(820, 821.4)).toBeUndefined()
  })

  it('forces the offset back when the lock leaked', () => {
    expect(scrollRestoreTarget(820, 0)).toBe(820)
    expect(scrollRestoreTarget(820, 400)).toBe(820)
  })

  it('ignores an offset it never recorded', () => {
    expect(scrollRestoreTarget(Number.NaN, 400)).toBeUndefined()
    expect(scrollRestoreTarget(-1, 400)).toBeUndefined()
  })

  it('shows the back-to-top control only past a flick of content', () => {
    expect(shouldShowBackToTop(0)).toBe(false)
    expect(shouldShowBackToTop(400)).toBe(false)
    expect(shouldShowBackToTop(401)).toBe(true)
  })
})

describe('connection state', () => {
  const copy = {
    connected: 'verbunden',
    connecting: 'verbinde …',
    reconnecting: 'verbinde neu …',
    offline: 'offline'
  }

  it('says offline before it promises a reconnect it cannot keep', () => {
    expect(connectionState('connecting', false, true)).toBe('offline')
    expect(connectionState('ready', false, true)).toBe('offline')
  })

  it('separates the first connect from a recovery', () => {
    expect(connectionState('connecting', true, false)).toBe('connecting')
    expect(connectionState('connecting', true, true)).toBe('reconnecting')
    expect(connectionState('ready', true, true)).toBe('connected')
  })

  it('marks the two unhappy states without dropping the healthy class', () => {
    expect(connectionClass('connected')).toBe('conn ok')
    expect(connectionClass('connecting')).toBe('conn')
    expect(connectionClass('reconnecting')).toBe('conn is-reconnecting')
    expect(connectionClass('offline')).toBe('conn is-offline')
  })

  it('maps every state onto copy', () => {
    expect(connectionLabel('offline', copy)).toBe('offline')
    expect(connectionLabel('reconnecting', copy)).toBe('verbinde neu …')
    expect(connectionLabel('connected', copy)).toBe('verbunden')
    expect(connectionLabel('connecting', copy)).toBe('verbinde …')
  })
})
