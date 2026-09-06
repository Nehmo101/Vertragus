import { createElement, useState } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { Composer, GoalRefillForm, createDraftWriter } from './App'
import { remoteCopy } from './i18n'
import { composerDraftKey } from './navState'
import type { RemoteApi } from './useRemote'

vi.mock('./haptics', () => ({ haptic: vi.fn() }))

it('locks remote steering until acknowledgement and keeps subsequent edits', async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  let resolve!: () => void
  const runCommand = vi.fn(() => new Promise<void>((done) => { resolve = done }))
  const api = { runCommand } as unknown as RemoteApi
  function Form(): React.ReactElement {
    const [drafts, update] = useState<Record<string, string>>({ [composerDraftKey('run')]: 'first' })
    const [setDraft] = useState(() => createDraftWriter(update))
    return createElement(Composer, { api, workspaceId: 'run', agents: [], copy: remoteCopy('en'), drafts, setDraft })
  }
  let tree!: ReturnType<typeof create>
  act(() => { tree = create(createElement(Form)) })
  const submit = (): void => tree.root.findByType('form').props.onSubmit({ preventDefault() {} })
  act(submit)
  await act(async () => { await Promise.resolve(); submit() })
  expect(runCommand).toHaveBeenCalledTimes(1)
  act(() => tree.root.findByType('textarea').props.onChange({ target: { value: 'new unsent text' } }))
  await act(async () => { resolve(); await Promise.resolve() })
  expect(tree.root.findByType('textarea').props.value).toBe('new unsent text')
  expect(tree.root.findByProps({ type: 'submit' }).props.disabled).toBe(false)
  act(() => tree.unmount())
})

it('preserves a remote goal across remounts and failed or delayed host acknowledgements', async () => {
  let resolve!: () => void
  const runCommand = vi.fn().mockRejectedValueOnce(new Error('Host busy')).mockImplementation(() => new Promise<void>((done) => { resolve = done }))
  const props = { api: { runCommand } as unknown as RemoteApi, workspaceId: 'refill-persist', copy: remoteCopy('en'), hint: 'Add goal' }
  let tree!: ReturnType<typeof create>
  act(() => { tree = create(createElement(GoalRefillForm, props)) })
  const open = () => act(() => tree.root.findAllByType('button')[0].props.onClick())
  open()
  act(() => tree.root.findByType('textarea').props.onChange({ target: { value: 'Original goal' } }))
  await act(async () => tree.root.findAllByType('button')[1].props.onClick())
  expect(tree.root.findByType('textarea').props.value).toBe('Original goal')
  expect(tree.root.findByProps({ className: 'form-error' }).children).toContain('Host busy')
  act(() => tree.unmount())
  act(() => { tree = create(createElement(GoalRefillForm, props)) })
  open()
  expect(tree.root.findByType('textarea').props.value).toBe('Original goal')
  act(() => tree.root.findAllByType('button')[1].props.onClick())
  act(() => tree.root.findByType('textarea').props.onChange({ target: { value: 'Revised goal' } }))
  await act(async () => resolve())
  expect(tree.root.findByType('textarea').props.value).toBe('Revised goal')
  act(() => tree.root.findAllByType('button')[1].props.onClick())
  await act(async () => resolve())
  expect(tree.root.findAllByType('textarea')).toHaveLength(0)
  open()
  expect(tree.root.findByType('textarea').props.value).toBe('')
  act(() => tree.unmount())
})
