import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { Profile } from '@shared/schema/profile'
import { ProfileRow } from './ProfileRow'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))

it('retains the full goal and staged image IDs after a failed start, then retries once', async () => {
  vi.stubGlobal('window', { sessionStorage: {
    getItem: (key: string) => key.endsWith('attachments') ? '["staged-image"]' : null,
    setItem: vi.fn()
  } })
  const onStart = vi.fn().mockRejectedValueOnce(new Error('CLI unavailable')).mockResolvedValue(undefined)
  const noop = (): void => undefined
  const profile = { id: 'failed-start-retention', name: 'Demo', repoPath: 'C:/repo' } as Profile
  let tree!: ReturnType<typeof create>
  act(() => { tree = create(createElement(ProfileRow, {
    profile, count: 0, selected: false, cleanupOpen: false, retroOpen: false, archiveOpen: false,
    liveWorkspaceIds: [], onStart, onResume: async () => undefined,
    onSelect: noop, onEdit: noop, onToggleCleanup: noop, onToggleRetro: noop, onToggleArchive: noop
  })) })
  act(() => tree.root.findByProps({ className: 'panel-play' }).props.onClick())
  act(() => tree.root.findByType('textarea').props.onChange({ target: { value: 'Implement with the attached screenshot' } }))
  await act(async () => tree.root.findByProps({ className: 'panel-goal-start' }).props.onClick())
  expect(tree.root.findByType('textarea').props.value).toBe('Implement with the attached screenshot')
  expect(tree.root.findByProps({ role: 'alert' }).children).toContain('CLI unavailable')
  await act(async () => tree.root.findByProps({ className: 'panel-goal-start' }).props.onClick())
  expect(onStart).toHaveBeenCalledTimes(2)
  expect(onStart).toHaveBeenLastCalledWith(profile.id, 'Implement with the attached screenshot', ['staged-image'])
  expect(tree.root.findAllByType('textarea')).toHaveLength(0)
  act(() => tree.unmount())
})
