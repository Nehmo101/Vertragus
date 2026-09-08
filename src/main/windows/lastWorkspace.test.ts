import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  forgetLastWorkspace,
  forgetWorkspace,
  getLastWorkspaceId,
  lastWorkspaceId,
  recordLastWorkspace,
  rememberWorkspace,
  resetLastWorkspaceForTesting,
  selectWorkspace,
  workspaceWindowVisibility
} from './lastWorkspace'

beforeEach(() => {
  resetLastWorkspaceForTesting()
})

describe('rememberWorkspace', () => {
  it('puts the id first and demotes a previous mention', () => {
    expect(rememberWorkspace([], 'w1')).toEqual(['w1'])
    expect(rememberWorkspace(['a', 'b'], 'b')).toEqual(['b', 'a'])
    expect(rememberWorkspace(['a', 'b'], 'c')).toEqual(['c', 'a', 'b'])
  })

  it('ignores a blank id', () => {
    expect(rememberWorkspace(['a'], '  ')).toEqual(['a'])
    expect(rememberWorkspace(['a'], '')).toEqual(['a'])
  })

  it('does not mutate the input', () => {
    const recency = ['a']
    rememberWorkspace(recency, 'b')
    expect(recency).toEqual(['a'])
  })
})

describe('forgetWorkspace', () => {
  it('falls back to the next recency entry that is still live', () => {
    expect(forgetWorkspace(['a', 'b', 'c'], 'a', ['b', 'c'])).toEqual(['b', 'c'])
  })

  it('drops stale recency entries that are no longer live', () => {
    expect(forgetWorkspace(['a', 'gone', 'b'], 'a', ['b'])).toEqual(['b'])
  })

  it('falls back to the most recently started live workspace when recency is empty', () => {
    expect(forgetWorkspace(['a'], 'a', ['old', 'a', 'newest'])).toEqual(['newest'])
    expect(forgetWorkspace([], 'ghost', ['old', 'newest'])).toEqual(['newest'])
  })

  it('returns empty when nothing live remains', () => {
    expect(forgetWorkspace(['a'], 'a', ['a'])).toEqual([])
    expect(forgetWorkspace(['a'], 'a', [])).toEqual([])
  })
})

describe('lastWorkspaceId', () => {
  it('reads the front of recency', () => {
    expect(lastWorkspaceId([])).toBeUndefined()
    expect(lastWorkspaceId(['w2', 'w1'])).toBe('w2')
  })
})

describe('the production store', () => {
  it('records focus/start order and forgets onto the next live workspace', () => {
    recordLastWorkspace('w1')
    recordLastWorkspace('w2')
    expect(getLastWorkspaceId()).toBe('w2')
    forgetLastWorkspace('w2', ['w1'])
    expect(getLastWorkspaceId()).toBe('w1')
    forgetLastWorkspace('w1', [])
    expect(getLastWorkspaceId()).toBeUndefined()
  })
})

describe('production wiring', () => {
  it('records last workspace on focus, start, resume and stop', () => {
    const source = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    const wiring = readFileSync(join(__dirname, '../devRun.ts'), 'utf8')
    expect(wiring).toMatch(/onWorkspaceStarting:\s*recordLastWorkspace/)
    expect(wiring).toMatch(/onWorkspaceRemoved:\s*forgetLastWorkspace/)
    expect(source).toMatch(/getLastWorkspaceId\(/)
    expect(source).toMatch(/setHideAllRestoreWorkspace/)
    const focusAt = source.indexOf('focusWorkspace(workspaceId)')
    expect(focusAt).toBeGreaterThanOrEqual(0)
    const focusBlock = source.slice(focusAt, source.indexOf('async readTimelineEvents'))
    expect(focusBlock).toMatch(/selectWorkspace\(workspaceId\)/)
  })
})


describe('workspace window visibility', () => {
  it('keeps startup preferences until explicit selection; hide-all and background win', () => {
    recordLastWorkspace('a')
    expect(workspaceWindowVisibility('a', false)).toBe('default')
    expect(workspaceWindowVisibility('b', false)).toBe('hidden')
    selectWorkspace('a')
    expect(workspaceWindowVisibility('a', false)).toBe('visible')
    expect(workspaceWindowVisibility('a', true)).toBe('hidden')
    recordLastWorkspace('b')
    expect(workspaceWindowVisibility('a', false)).toBe('hidden')
    expect(workspaceWindowVisibility('b', false)).toBe('default')
    selectWorkspace('b')
    forgetLastWorkspace('b', ['a'])
    expect(workspaceWindowVisibility('a', false)).toBe('default')
  })
})
