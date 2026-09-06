import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentEvent } from '@shared/schema/events'
import { activeLocale } from '../i18n'
import { formatEvent, formatEventTime } from './formatEvent'

export const EVENT_ROW_HEIGHT = 76
export const EVENT_VIEWPORT_HEIGHT = 380

/** Bounded DOM even when the journal contains a day of agent activity. */
export function EventJournal({ events }: { events: readonly AgentEvent[] }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const locale = activeLocale(i18n.language)
  const [query, setQuery] = useState('')
  const [agent, setAgent] = useState('')
  const [kind, setKind] = useState('')
  const [offset, setOffset] = useState(0)
  const [unseen, setUnseen] = useState(0)
  const [selected, setSelected] = useState<AgentEvent | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const previousCount = useRef(events.length)
  const kinds = useMemo(() => [...new Set(events.map((event) => event.type))], [events])
  const agents = useMemo(() => [...new Set(events.flatMap((event) => 'agentId' in event ? [event.agentId] : []))], [events])
  const filtered = useMemo(() => events.filter((event) =>
    (!kind || event.type === kind) &&
    (!agent || ('agentId' in event && event.agentId === agent)) &&
    (!query.trim() || JSON.stringify(event).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  ), [events, kind, agent, query])
  const totalHeight = filtered.length * EVENT_ROW_HEIGHT
  const visibleCount = Math.ceil(EVENT_VIEWPORT_HEIGHT / EVENT_ROW_HEIGHT) + 8
  const start = Math.min(Math.max(0, Math.floor(offset / EVENT_ROW_HEIGHT) - 4), Math.max(0, filtered.length - visibleCount))
  const visible = filtered.slice(start, start + visibleCount)
  useLayoutEffect(() => {
    const added = Math.max(0, events.length - previousCount.current)
    previousCount.current = events.length
    if (following.current) {
      const end = Math.max(0, totalHeight - EVENT_VIEWPORT_HEIGHT)
      if (viewport.current) viewport.current.scrollTop = end
      setOffset(end)
      setUnseen(0)
    } else if (added > 0) setUnseen((current) => current + added)
  }, [events.length, totalHeight])
  const details = selected ? formatEvent(t, selected, locale) : null
  return <>
    <div className="tl-filters">
      <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('timeline.search')} placeholder={t('timeline.search')} />
      <select value={agent} onChange={(event) => setAgent(event.target.value)} aria-label={t('timeline.agentFilter')}>
        <option value="">{t('timeline.allAgents')}</option>
        {agents.map((id) => <option key={id} value={id}>{id}</option>)}
      </select>
      <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label={t('timeline.typeFilter')}>
        <option value="">{t('timeline.allEvents')}</option>
        {kinds.map((type) => <option key={type} value={type}>{t(`timeline.event.${type}`, { name: '', roleId: '', summary: '', message: '', question: '', note: '', text: '', branch: '', status: '' }).trim()}</option>)}
      </select>
    </div>
    <div className="tl-viewport" ref={viewport} style={{ height: EVENT_VIEWPORT_HEIGHT }} onScroll={(event) => {
      const node = event.currentTarget
      following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32
      setOffset(node.scrollTop)
      if (following.current) setUnseen(0)
    }}>
      <ul className="tl-virtual-list" style={{ height: totalHeight }} aria-label={t('timeline.eventsLabel')}>
        {visible.map((event, index) => {
          const row = formatEvent(t, event, locale)
          return <li key={row.seq} style={{ top: (start + index) * EVENT_ROW_HEIGHT, height: EVENT_ROW_HEIGHT }}>
            <button type="button" className="tl-event" onClick={() => setSelected(event)}>
              <span className="tl-event-time">{formatEventTime(row.ts, locale)}</span>
              <span className="tl-event-label">{row.label}</span>
              {row.detail ? <span className="tl-event-detail">{row.detail}</span> : null}
            </button>
          </li>
        })}
      </ul>
    </div>
    {filtered.length === 0 ? <p className="tl-empty">{t('timeline.eventsEmpty')}</p> : null}
    {unseen > 0 ? <button type="button" className="panel-new" onClick={() => {
      following.current = true
      const end = Math.max(0, totalHeight - EVENT_VIEWPORT_HEIGHT)
      if (viewport.current) viewport.current.scrollTop = end
      setOffset(end); setUnseen(0)
    }}>{t('timeline.newEvents', { count: unseen })}</button> : null}
    {details ? <section className="tl-inspector"><strong>{details.label}</strong><p>{details.detail}</p></section> : null}
  </>
}
