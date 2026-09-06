import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { SessionPane } from './SessionPane'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

it('shows all CLI choice labels and sends the clicked value through the question API', async () => {
  vi.stubGlobal('window', { sessionStorage: { getItem: () => null, setItem: vi.fn() } })
  const onAnswer = vi.fn(async () => undefined)
  let tree!: ReturnType<typeof create>
  act(() => { tree = create(createElement(SessionPane, {
    agentId: 'root', running: true, onAnswer, onFollowUp: async () => undefined,
    session: { workspaceId: 'choices-test', kind: 'orchestrator', state: 'waiting', log: [], userQuestion: { questionId: 'choice-q', question: 'Where?', choices: ['Staging', 'Production'] } }
  })) })
  const choices = tree.root.findAllByType('button').filter((entry) => entry.children.includes('Staging') || entry.children.includes('Production'))
  expect(choices).toHaveLength(2)
  await act(async () => choices[0].props.onClick())
  expect(onAnswer).toHaveBeenCalledWith('choice-q', 'Staging')
  act(() => tree.unmount())
})
