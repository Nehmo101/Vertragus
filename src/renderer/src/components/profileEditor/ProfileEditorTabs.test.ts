import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ProfileEditorTabs, {
  profileEditorPanelDomId,
  profileEditorTabDomId,
  type ProfileEditorTab
} from './ProfileEditorTabs'

const tabs: ProfileEditorTab[] = [
  { id: 'repo', label: 'Repo & GitHub', summary: 'vertragus' },
  { id: 'mode', label: 'Modus & Orchestrator', summary: 'Orchestriert · claude/opus' },
  {
    id: 'automation',
    label: 'Auto-PR & Git',
    summary: 'Auto-PR aus · Push auf ?',
    badge: 'Ziel-Branch korrigieren'
  }
]

function markup(activeTab: ProfileEditorTab['id'] = 'repo'): string {
  return renderToStaticMarkup(
    createElement(ProfileEditorTabs, { tabs, activeTab, onSelect: vi.fn() })
  )
}

describe('ProfileEditorTabs', () => {
  it('renders the WAI-ARIA tabs pattern with a roving tabindex', () => {
    const html = markup('mode')
    expect(html).toContain('role="tablist"')
    expect(html.match(/role="tab"/g)).toHaveLength(3)
    expect(html).toContain(
      `id="${profileEditorTabDomId('mode')}" aria-controls="${profileEditorPanelDomId('mode')}" aria-selected="true" tabindex="0"`
    )
    expect(html).toContain(
      `id="${profileEditorTabDomId('repo')}" aria-controls="${profileEditorPanelDomId('repo')}" aria-selected="false" tabindex="-1"`
    )
  })

  it('shows the summary line and mirrors it into the title', () => {
    const html = markup()
    expect(html).toContain('Orchestriert · claude/opus')
    expect(html).toContain('title="vertragus"')
  })

  it('marks a tab with a hidden validation issue via badge + accessible text', () => {
    const html = markup()
    // Dot is decorative; the message is exposed as text and in the title.
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('Ziel-Branch korrigieren')
    expect(html).toContain('title="Auto-PR aus · Push auf ? — Ziel-Branch korrigieren"')
  })

  it('keeps tabs without an issue badge-free', () => {
    const html = markup()
    const repoTab = html.slice(html.indexOf('Repo &amp; GitHub'), html.indexOf('Modus'))
    expect(repoTab).not.toContain('aria-hidden')
  })
})
