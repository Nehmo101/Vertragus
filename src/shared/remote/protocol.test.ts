import { describe, expect, it } from 'vitest'
import { parseClientMessage, REMOTE_COMMANDS } from './protocol'

describe('parseClientMessage', () => {
  it('accepts every well-formed client frame', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'auth', session: 's' }))).toMatchObject({
      type: 'auth'
    })
    expect(parseClientMessage(JSON.stringify({ type: 'attach', agentId: 'a1' }))).toMatchObject({
      type: 'attach',
      agentId: 'a1'
    })
    expect(
      parseClientMessage(JSON.stringify({ type: 'input', agentId: 'a1', data: 'ls\r' }))
    ).toMatchObject({ type: 'input', data: 'ls\r' })
    expect(
      parseClientMessage(JSON.stringify({ type: 'resize', agentId: 'a1', cols: 80, rows: 24 }))
    ).toMatchObject({ type: 'resize', cols: 80 })
    expect(
      parseClientMessage(JSON.stringify({ type: 'command', id: 'c1', name: 'workspaces:list' }))
    ).toMatchObject({ type: 'command', name: 'workspaces:list' })
    expect(parseClientMessage(JSON.stringify({ type: 'refresh' }))).toMatchObject({ type: 'refresh' })
  })

  it('rejects malformed JSON and unknown types', () => {
    expect(parseClientMessage('not json')).toBeUndefined()
    expect(parseClientMessage(JSON.stringify({ type: 'evil' }))).toBeUndefined()
    expect(parseClientMessage(JSON.stringify({ type: 'auth' }))).toBeUndefined()
  })

  it('rejects a command outside the allow-list', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'command', id: 'c', name: 'settings:write' }))
    ).toBeUndefined()
  })

  it('bounds oversized and out-of-range fields', () => {
    const hugeInput = JSON.stringify({ type: 'input', agentId: 'a', data: 'x'.repeat(70_000) })
    expect(parseClientMessage(hugeInput)).toBeUndefined()
    const badResize = JSON.stringify({ type: 'resize', agentId: 'a', cols: -1, rows: 24 })
    expect(parseClientMessage(badResize)).toBeUndefined()
    const hugeResize = JSON.stringify({ type: 'resize', agentId: 'a', cols: 99_999, rows: 24 })
    expect(parseClientMessage(hugeResize)).toBeUndefined()
  })

  it('the command allow-list is exactly the four documented verbs', () => {
    expect([...REMOTE_COMMANDS].sort()).toEqual([
      'profiles:list',
      'workspaces:list',
      'workspaces:start',
      'workspaces:stop'
    ])
  })
})
