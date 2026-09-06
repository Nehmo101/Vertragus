import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraft, useSubmission } from './useDraft'

describe('drafts across asynchronous submission and remounts', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { sessionStorage: { getItem: () => null, setItem: vi.fn() } })
  })

  it('retains rejected input, prevents concurrent requests, and preserves a later edit', async () => {
    let state!: ReturnType<typeof useDraft<string>>
    let send!: ReturnType<typeof useSubmission>
    function Form(): null { state = useDraft('async-test', ''); send = useSubmission(); return null }
    let tree!: ReactTestRenderer
    act(() => { tree = create(createElement(Form)) })
    act(() => state.set('first'))
    const version = state.version()
    let reject!: (error: Error) => void
    const action = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    let pending!: Promise<boolean>
    act(() => { pending = send.run(action); void send.run(action) })
    expect(action).toHaveBeenCalledTimes(1)
    await act(async () => { reject(new Error('offline')); await pending })
    expect(state.value).toBe('first')
    expect(send.error).toBe('offline')
    act(() => state.set('second'))
    act(() => { expect(state.clear(version)).toBe(false) })
    expect(state.value).toBe('second')
    act(() => tree.unmount())
    act(() => { tree = create(createElement(Form)) })
    expect(state.value).toBe('second')
    act(() => tree.unmount())
  })

  it('switches question identities and synchronizes two views of the same draft', () => {
    let one!: ReturnType<typeof useDraft<string>>
    let two!: ReturnType<typeof useDraft<string>>
    function First({ id }: { id: string }): null { one = useDraft(id, ''); return null }
    function Second(): null { two = useDraft('same-question', ''); return null }
    let a!: ReactTestRenderer, b!: ReactTestRenderer
    act(() => { a = create(createElement(First, { id: 'same-question' })); b = create(createElement(Second)) })
    act(() => one.set('answer'))
    expect(two.value).toBe('answer')
    act(() => a.update(createElement(First, { id: 'next-question' })))
    expect(one.value).toBe('')
    expect(two.value).toBe('answer')
    act(() => { a.unmount(); b.unmount() })
  })

  it('restores stored drafts and shares a pending request between inbox and card until success', async () => {
    vi.stubGlobal('window', { sessionStorage: { getItem: () => '"stored answer"', setItem: vi.fn() } })
    const states: Array<ReturnType<typeof useSubmission>> = []
    let draft!: ReturnType<typeof useDraft<string>>
    function View({ index }: { index: number }): null { draft = useDraft('stored-question', ''); states[index] = useSubmission('question-lock'); return null }
    let one!: ReactTestRenderer, two!: ReactTestRenderer
    act(() => { one = create(createElement(View, { index: 0 })); two = create(createElement(View, { index: 1 })) })
    expect(draft.value).toBe('stored answer')
    act(() => draft.set((previous) => `${previous}!`))
    let resolve!: () => void
    const action = vi.fn(() => new Promise<void>((done) => { resolve = done }))
    let request!: Promise<boolean>
    act(() => { request = states[0].run(action); void states[1].run(action) })
    expect(action).toHaveBeenCalledOnce()
    expect(states[1].busy).toBe(true)
    await act(async () => { resolve(); expect(await request).toBe(true) })
    expect(states[1].busy).toBe(false)
    act(() => { expect(draft.clear(draft.version())).toBe(true) })
    expect(draft.value).toBe('')
    await act(async () => { await states[1].run(async () => { throw 'Offline' }) })
    expect(states[1].error).toBe('Offline')
    act(() => { one.unmount(); two.unmount() })
  })
})
