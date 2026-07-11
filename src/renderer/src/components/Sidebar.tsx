import { useAppStore } from '@renderer/store/useAppStore'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import { profileSummary, profileAgentCount } from '@renderer/components/TitleBar'
import type { ProviderHealth, ProviderId } from '@shared/providers'

interface RowStatus {
  label: string
  dot: string
  text: string
}

function statusFor(id: ProviderId, h: ProviderHealth | undefined): RowStatus {
  if (!h) return { label: 'Prüfe…', dot: '#e9b949', text: '#f2c85a' }
  if (!h.available) return { label: 'Fehlt', dot: '#f2555a', text: '#ff7377' }
  switch (id) {
    case 'ollama':
      return { label: 'Lokal', dot: '#3fd17a', text: '#5fe39a' }
    case 'github':
      return { label: 'Verb.', dot: '#3fd17a', text: '#5fe39a' }
    case 'cloudflare':
      return { label: 'Bereit', dot: '#22d3ee', text: '#7fdfff' }
    default:
      return { label: 'Auth', dot: '#3fd17a', text: '#5fe39a' }
  }
}

function detailFor(h: ProviderHealth | undefined): string {
  if (!h) return '…'
  if (!h.available) return 'nicht installiert'
  return h.detail ?? h.version ?? 'installiert'
}

function ProviderRow({ id }: { id: ProviderId }): JSX.Element {
  const health = useAppStore((s) => s.health)
  const theme = PROVIDER_THEME[id]
  const h = health.find((x) => x.id === id)
  const st = statusFor(id, h)
  return (
    <div className="provider-row">
      <span className="chip sz-26" style={{ background: theme.bg, color: theme.fg }}>
        {theme.mono}
      </span>
      <div className="info">
        <div className="name">{theme.label}</div>
        <div className="detail" title={detailFor(h)}>
          {detailFor(h)}
        </div>
      </div>
      <span className="status-wrap">
        <span
          className="status-dot"
          style={{ background: st.dot, boxShadow: `0 0 7px ${st.dot}` }}
        />
        <span className="status-label" style={{ color: st.text }}>
          {st.label}
        </span>
      </span>
    </div>
  )
}

export default function Sidebar(): JSX.Element {
  const store = useAppStore()
  const aiIds: ProviderId[] = ['claude', 'codex', 'cursor', 'ollama']
  const onlineCount = aiIds.filter(
    (id) => store.health.find((h) => h.id === id)?.available
  ).length

  return (
    <aside className="sidebar">
      <div className="side-caption">
        <span>KI-Provider</span>
        <span className="online-pill">{onlineCount} online</span>
      </div>
      <div className="side-list">
        {aiIds.map((id) => (
          <ProviderRow key={id} id={id} />
        ))}
      </div>

      <div className="side-caption" style={{ paddingTop: 14 }}>
        <span>Infrastruktur</span>
      </div>
      <div className="side-list">
        <ProviderRow id="github" />
        <ProviderRow id="cloudflare" />
      </div>

      <div className="side-sep" />

      <div className="side-caption" style={{ paddingTop: 10 }}>
        <span>Workspace-Profile</span>
        <button className="icon-btn-sm" title="Neues Profil" onClick={store.openEditorNew}>
          ＋
        </button>
      </div>
      <div className="side-list" style={{ paddingBottom: 14 }}>
        {store.profiles.map((p) => (
          <div
            key={p.id}
            className={`profile-row ${p.id === store.activeProfileId ? 'active' : ''}`}
            onClick={() => void store.selectProfile(p.id)}
            onDoubleClick={() => store.openEditor(p)}
            title="Klick: aktivieren · Doppelklick: bearbeiten"
          >
            <span className="profile-rail" />
            <div className="info">
              <div className="name">{p.name}</div>
              <div className="summary">{profileSummary(p)}</div>
            </div>
            <span className="profile-count">{profileAgentCount(p)}</span>
          </div>
        ))}
      </div>
    </aside>
  )
}
