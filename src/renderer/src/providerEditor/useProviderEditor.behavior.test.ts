import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { useProviderEditor } from './useProviderEditor'

const language = vi.hoisted(() => ({ translate: (key: string) => key }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: language.translate }) }))

it('keeps an unsaved provider draft when the UI language changes', async () => {
  const listProviders = vi.fn(async () => [])
  vi.stubGlobal('window', { vertragus: { app: { listProviders } } })
  let editor!: ReturnType<typeof useProviderEditor>
  function Form(): null { editor = useProviderEditor(); return null }
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(createElement(Form)) })
  act(() => editor.update((draft) => ({ ...draft, label: 'unsaved provider' })))
  language.translate = (key) => `new language: ${key}`
  await act(async () => tree.update(createElement(Form)))
  expect(editor.draft?.label).toBe('unsaved provider')
  expect(listProviders).toHaveBeenCalledTimes(1)
  act(() => tree.unmount())
})
