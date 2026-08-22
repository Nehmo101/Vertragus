import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  answerDraftKey,
  ARG_MAX_CHARS,
  composerDraftKey,
  connectionClass,
  connectionLabel,
  connectionState,
  draftWorkspaceId,
  EXPANSION_KEY,
  GOAL_DRAFT_KEY,
  historyAction,
  liveDraftKeys,
  orphanedDrafts,
  parseExpansionState,
  popstateAction,
  pruneDrafts,
  pruneExpansionState,
  readExpansionState,
  readStored,
  scrollBehavior,
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

  it('writes nothing at all until the client knows of a workspace', () => {
    // The failure this guards: `useRemote` starts `workspaces` at [], so the
    // first commit of a client that never reached the host would prune every
    // remembered card against a list of nothing and overwrite the store with
    // "{}". Open the app out of tailnet range once and every collapse decision
    // the user ever made is gone.
    const storage = memoryStorage({ [EXPANSION_KEY]: '{"w1":false,"w2":true}' })
    writeExpansionState({}, [], storage)
    expect(storage.data.get(EXPANSION_KEY)).toBe('{"w1":false,"w2":true}')
    expect(readExpansionState(storage)).toEqual({ w1: false, w2: true })
    // The first real push prunes as before.
    writeExpansionState({ w1: false, w2: true }, ['w1'], storage)
    expect(readExpansionState(storage)).toEqual({ w1: false })
  })
})

describe('the draft map', () => {
  const ids = ['w1', 'w2']
  const composer = composerDraftKey('w1')
  const answer = answerDraftKey('w1:user:q-1')

  it('keeps only text a field could still be reached from', () => {
    const drafts = {
      [GOAL_DRAFT_KEY]: 'ship it',
      [composer]: 'half a message',
      [answer]: 'half an answer',
      [composerDraftKey('gone')]: 'text for a run the host forgot',
      [answerDraftKey('gone:a1:q')]: 'ditto'
    }
    expect(pruneDrafts(drafts, ids)).toEqual({
      [GOAL_DRAFT_KEY]: 'ship it',
      [composer]: 'half a message',
      [answer]: 'half an answer'
    })
  })

  it('drops the empty strings a successful send used to leave behind forever', () => {
    expect(pruneDrafts({ [composer]: '', [answer]: 'kept' }, ids)).toEqual({ [answer]: 'kept' })
  })

  it('hands back the same object when nothing was dropped', () => {
    const drafts = { [GOAL_DRAFT_KEY]: 'a', [composer]: 'b' }
    expect(pruneDrafts(drafts, ids)).toBe(drafts)
  })

  it('matches a key to its run by the ids that exist, not by splitting on ":"', () => {
    // A host id with a colon in it would make a parser guess wrong the first
    // time; comparison against the real ids cannot.
    const odd = 'ws:2024:07'
    expect(draftWorkspaceId(composerDraftKey(odd), [odd])).toBe(odd)
    expect(draftWorkspaceId(answerDraftKey(`${odd}:user:q`), [odd])).toBe(odd)
    expect(draftWorkspaceId(GOAL_DRAFT_KEY, [odd])).toBeUndefined()
    expect(draftWorkspaceId(composerDraftKey('other'), [odd])).toBeUndefined()
  })

  it('names the fields the screen can still show', () => {
    expect(liveDraftKeys(['w1'], ['w1:user:q-1'])).toEqual([
      GOAL_DRAFT_KEY,
      'composer:w1',
      'answer:w1:user:q-1'
    ])
  })
})

describe('text with nowhere left to go', () => {
  it('surfaces an answer whose question was answered from the desktop', () => {
    // The field unmounts with the inbox entry: until now the half-typed answer
    // left the screen mid-sentence with nothing said about it.
    const drafts = { [answerDraftKey('w1:a1:q-1')]: 'use bcrypt' }
    const orphans = orphanedDrafts(drafts, liveDraftKeys(['w1'], []), ['w1'])
    expect(orphans).toEqual([
      { key: 'answer:w1:a1:q-1', text: 'use bcrypt', kind: 'answer', workspaceId: 'w1' }
    ])
  })

  it('surfaces a composer draft for a run that has ended', () => {
    const drafts = { [composerDraftKey('w1')]: 'try the other branch' }
    // The run is still on the list, but ended — so no composer is drawn for it.
    const orphans = orphanedDrafts(drafts, [GOAL_DRAFT_KEY], ['w1'])
    expect(orphans[0]).toMatchObject({ kind: 'composer', workspaceId: 'w1' })
  })

  it('says nothing about text a field is still showing, or about whitespace', () => {
    const live = liveDraftKeys(['w1'], ['w1:a1:q-1'])
    const drafts = {
      [GOAL_DRAFT_KEY]: 'a goal',
      [composerDraftKey('w1')]: 'still typing',
      [answerDraftKey('w1:a1:q-1')]: 'still answering',
      [answerDraftKey('w1:a1:q-old')]: '   '
    }
    expect(orphanedDrafts(drafts, live, ['w1'])).toEqual([])
  })

  it('is ordered, so the notice does not reshuffle under a thumb', () => {
    const drafts = {
      [composerDraftKey('w2')]: 'b',
      [answerDraftKey('w1:a1:q')]: 'a'
    }
    expect(orphanedDrafts(drafts, [], ['w1', 'w2']).map((entry) => entry.key)).toEqual([
      'answer:w1:a1:q',
      'composer:w2'
    ])
  })
})

describe('the wire length cap', () => {
  it('matches the schema that would drop a longer frame', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../shared/remote/protocol.ts'),
      'utf8'
    )
    const match = /z\.record\(z\.string\(\)\.max\(\d+\), z\.string\(\)\.max\(([\d_]+)\)\)/.exec(
      source
    )
    // Self-check: a reshaped schema must fail loudly here rather than silently
    // stop being scanned.
    expect(match, 'args schema not found in protocol.ts').not.toBeNull()
    expect(Number(match?.[1]?.replaceAll('_', ''))).toBe(ARG_MAX_CHARS)
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

  it('does nothing when nothing was open and nothing opened', () => {
    // The eighth combination, and the one that used to answer 'back': with no
    // terminal on either side of the change there is no entry of ours to pop,
    // and a `back()` here walks the user clean out of the app.
    expect(historyAction(null, null, true)).toBe('none')
  })

  it('covers every input the effect can hand it', () => {
    const inputs = [null, 'agent-1'] as const
    for (const previous of inputs) {
      for (const next of inputs) {
        for (const pushed of [false, true]) {
          expect(['push', 'back', 'none']).toContain(historyAction(previous, next, pushed))
        }
      }
    }
    // The remaining pair, stated rather than merely ranged over.
    expect(historyAction('agent-1', 'agent-1', false)).toBe('none')
  })
})

describe('a pop that lands late', () => {
  it('closes the terminal for a hardware back', () => {
    expect(popstateAction(0, true)).toBe('close')
  })

  it('ignores a pop that is nobody’s', () => {
    expect(popstateAction(0, false)).toBe('none')
  })

  it('swallows the pop our own back() asked for', () => {
    // `history.back()` is a queued traversal. Close the terminal with the
    // in-app button and tap another agent in the same frame: `pushed` is back
    // at true by the time the pop lands, and without this the client closes
    // the terminal the user has only just opened.
    expect(popstateAction(1, true)).toBe('settle')
    expect(popstateAction(1, false)).toBe('settle')
    expect(popstateAction(2, true)).toBe('settle')
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

  it('does not animate the page for someone who asked it not to', () => {
    // An explicit `behavior` in a scrollTo outranks the sheet entirely, so
    // `styles.css`'s reduced-motion rule cannot reach this one.
    expect(scrollBehavior(true)).toBe('auto')
    expect(scrollBehavior(false)).toBe('smooth')
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
