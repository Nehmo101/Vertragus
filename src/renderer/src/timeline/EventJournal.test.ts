import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/schema/events'
import { EventJournal } from './EventJournal'

vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))

it('bounds rendering for 100,000 journal events and filters without losing full details', () => {
  const events: AgentEvent[] = Array.from({ length: 100_000 }, (_, seq) => ({
    type: 'agent_progress', seq, ts: seq * 1000, agentId: 'worker', name: 'Worker', roleId: 'worker', note: `Progress ${seq}`
  }))
  const started = performance.now()
  let tree!: ReturnType<typeof create>
  act(() => { tree = create(createElement(EventJournal, { events })) })
  const rows = tree.root.findAllByType('li').length
  const durationMs = performance.now() - started
  expect(rows).toBeLessThanOrEqual(14)
  expect(tree.root.findAllByProps({ className: 'tl-event-detail' }).at(-1)?.children).toContain('Progress 99999')
  act(() => tree.root.findAllByProps({ className: 'tl-event' }).at(-1)!.props.onClick())
  expect(tree.root.findByProps({ className: 'tl-inspector' }).findByType('p').children).toContain('Progress 99999')
  act(() => tree.root.findByType('input').props.onChange({ target: { value: 'Progress 81234' } }))
  expect(tree.root.findAllByType('li')).toHaveLength(1)
  console.info(JSON.stringify({ journalEvents: events.length, renderedRows: rows, initialRenderMs: Math.round(durationMs) }))
  act(() => tree.unmount())
})

it('preserves a reader position and offers the new-events action', () => {
  const event = { type: 'agent_progress', seq: 1, ts: 100, agentId: 'a', name: 'A', roleId: 'worker', note: 'first' } as const
  let tree!: ReturnType<typeof create>
  act(() => { tree = create(createElement(EventJournal, { events: [event] })) })
  act(() => tree.root.findByProps({ className: 'tl-viewport' }).props.onScroll({ currentTarget: { scrollHeight: 1000, scrollTop: 10, clientHeight: 380 } }))
  act(() => tree.update(createElement(EventJournal, { events: [event, { ...event, seq: 2, note: 'next' }] })))
  expect(tree.root.findByProps({ className: 'panel-new' }).children).toContain('timeline.newEvents')
  act(() => tree.root.findByProps({ className: 'panel-new' }).props.onClick())
  expect(tree.root.findAllByProps({ className: 'panel-new' })).toHaveLength(0)
  act(() => tree.unmount())
})

it('combines actor/type filters and an empty query result, then follows the actual scroll container', () => {
  const events = [
    { type: 'agent_progress', seq: 1, ts: 1, agentId: 'a', name: 'A', roleId: 'worker', note: 'first' },
    { type: 'agent_stopped', seq: 2, ts: 2, agentId: 'b', name: 'B', roleId: 'worker', note: 'second' },
    { type: 'workspace_stopped', seq: 3, ts: 3 }
  ] as AgentEvent[]
  const node = { scrollTop: 10, scrollHeight: 1000, clientHeight: 380 }
  let tree!: ReturnType<typeof create>
  act(() => { tree = create(createElement(EventJournal, { events }), { createNodeMock: () => node }) })
  expect(node.scrollTop).toBe(0)
  act(() => tree.root.findAllByType('select')[0].props.onChange({ target: { value: 'b' } }))
  expect(tree.root.findAllByType('li')).toHaveLength(1)
  act(() => tree.root.findAllByType('select')[1].props.onChange({ target: { value: 'agent_progress' } }))
  expect(tree.root.findAllByType('li')).toHaveLength(0)
  expect(tree.root.findByProps({ className: 'tl-empty' }).children).toContain('timeline.eventsEmpty')
  act(() => tree.root.findAllByType('select')[0].props.onChange({ target: { value: '' } }))
  expect(tree.root.findAllByType('li')).toHaveLength(1)
  act(() => tree.root.findByProps({ className: 'tl-viewport' }).props.onScroll({ currentTarget: node }))
  act(() => tree.update(createElement(EventJournal, { events: [...events, { ...events[0], seq: 4 }] })))
  act(() => tree.root.findByProps({ className: 'panel-new' }).props.onClick())
  expect(node.scrollTop).toBe(0)
  act(() => tree.root.findByProps({ className: 'tl-viewport' }).props.onScroll({ currentTarget: { ...node, scrollHeight: 380 } }))
  act(() => tree.unmount())
})
