import { memo, useRef, type KeyboardEvent } from 'react'
import type { ProfileEditorTabId } from './tabSummaries'
import styles from './ProfileEditorTabs.module.css'

export interface ProfileEditorTab {
  id: ProfileEditorTabId
  label: string
  /** Compact one-liner about the panel content, shown under the label. */
  summary: string
  /** Non-empty = a validation issue lives in this tab; renders a warn dot. */
  badge?: string
}

interface ProfileEditorTabsProps {
  tabs: ProfileEditorTab[]
  activeTab: ProfileEditorTabId
  onSelect: (id: ProfileEditorTabId) => void
}

export function profileEditorTabDomId(id: ProfileEditorTabId): string {
  return `profile-editor-tab-${id}`
}

export function profileEditorPanelDomId(id: ProfileEditorTabId): string {
  return `profile-editor-tabpanel-${id}`
}

/**
 * Tab bar of the profile editor. WAI-ARIA tabs pattern with a roving tabindex:
 * Left/Right/Home/End move focus AND select (selection follows focus), so the
 * panel switches without an extra Enter. Memoized like the sections — it only
 * re-renders together with its parent anyway, but stays cheap either way.
 */
const ProfileEditorTabs = memo(function ProfileEditorTabs({
  tabs,
  activeTab,
  onSelect
}: ProfileEditorTabsProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (tabs.length === 0) return
    const index = Math.max(0, tabs.findIndex((tab) => tab.id === activeTab))
    let next = -1
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    if (next < 0) return
    event.preventDefault()
    const target = tabs[next]
    onSelect(target.id)
    listRef.current
      ?.querySelector<HTMLElement>(`#${profileEditorTabDomId(target.id)}`)
      ?.focus()
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Profil-Bereiche"
      className={styles.tablist}
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTab
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={profileEditorTabDomId(tab.id)}
            aria-controls={profileEditorPanelDomId(tab.id)}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={[styles.tab, active ? styles.active : undefined]
              .filter(Boolean)
              .join(' ')}
            title={tab.badge ? `${tab.summary} — ${tab.badge}` : tab.summary}
            onClick={() => onSelect(tab.id)}
          >
            <span className={styles.label}>
              {tab.label}
              {tab.badge && <span className={styles.badge} aria-hidden="true" />}
              {tab.badge && <span className={styles.srOnly}>{tab.badge}</span>}
            </span>
            <span className={styles.summary}>{tab.summary}</span>
          </button>
        )
      })}
    </div>
  )
})

export default ProfileEditorTabs
