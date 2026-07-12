import { useEffect, useState } from 'react'
import { useAppStore } from '@renderer/store/useAppStore'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import { profileSummary, profileAgentCount } from '@renderer/components/TitleBar'
import type { ProviderHealth, ProviderId } from '@shared/providers'
import { MCP_SCOPE_LABELS, MCP_TRANSPORT_LABELS } from '@shared/mcp'

interface RowStatus {
  label: string
  dot: string
  text: string
}

function statusFor(id: ProviderId, h: ProviderHealth | undefined): RowStatus {
  if (!h) return { label: 'Prüfe…', dot: 'var(--wait)', text: 'var(--wait-text)' }
  if (!h.available) return { label: 'Fehlt', dot: 'var(--err)', text: 'var(--err-text)' }
  switch (h.connection) {
    case 'connected':
      return { label: 'Verbunden', dot: 'var(--run)', text: 'var(--run-text)' }
    case 'disconnected':
      return { label: 'Login', dot: 'var(--wait)', text: 'var(--wait-text)' }
    case 'local':
      return { label: 'Lokal', dot: 'var(--run)', text: 'var(--run-text)' }
    default:
      return {
        label: id === 'cloudflare' ? 'Bereit' : 'Installiert',
        dot: 'var(--sage)',
        text: 'var(--sage-strong)'
      }
  }
}

function detailFor(h: ProviderHealth | undefined): string {
  if (!h) return '…'
  if (!h.available) return 'nicht installiert'
  return h.detail ?? h.version ?? 'installiert'
}

function ProviderRow({ id }: { id: ProviderId }): JSX.Element {
  const store = useAppStore()
  const theme = PROVIDER_THEME[id]
  const h = store.health.find((x) => x.id === id)
  const st = statusFor(id, h)
  const loginRunning = store.agents.some(
    (agent) => agent.taskId === `auth:${id}` && agent.status === 'running'
  )
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
      {h?.available && h.canLogin && (
        <button
          type="button"
          className="provider-login-btn"
          disabled={loginRunning}
          title={
            loginRunning
              ? 'Login läuft bereits im Provider-Terminal'
              : `${h.loginLabel}. Orca speichert keine Zugangsdaten.`
          }
          aria-label={h.loginLabel ?? `${theme.label} verbinden`}
          onClick={() => void store.loginProvider(id)}
        >
          {loginRunning ? 'Offen' : h.connection === 'connected' ? 'Konto' : id === 'ollama' ? 'Cloud' : 'Login'}
        </button>
      )}
    </div>
  )
}


function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

export default function Sidebar(): JSX.Element {
  const store = useAppStore()
  const hash = useHashRoute()
  const aiIds: ProviderId[] = ['claude', 'codex', 'cursor', 'copilot', 'ollama']
  const onlineCount = aiIds.filter(
    (id) => store.health.find((h) => h.id === id)?.available
  ).length

  return (
    <aside className="sidebar">
      <div className="side-caption">
        <span>KI-Provider</span>
        <button
          type="button"
          className="provider-refresh-btn"
          title="Installation und Login-Status aller Provider neu prüfen"
          aria-label="Provider-Status aktualisieren"
          onClick={() => void store.refreshHealth()}
        >
          ↻
        </button>
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

      <div className="side-caption" style={{ paddingTop: 14 }}>
        <span>MCP-Server</span>
        <button
          type="button"
          className="icon-btn-sm"
          title="MCP-Server verwalten — für alle Agents sichtbar"
          aria-label="MCP-Server verwalten"
          onClick={store.openMcpEditor}
        >
          ⚙
        </button>
      </div>
      <div className="side-list">
        {store.mcpServers.length === 0 ? (
          <button
            type="button"
            className="mcp-empty-row"
            title="MCP-Server hinzufügen, die alle Agents sehen und nutzen können"
            onClick={store.openMcpEditor}
          >
            ＋ MCP-Server anbinden
          </button>
        ) : (
          store.mcpServers.map((server) => (
            <button
              type="button"
              key={server.id}
              className="mcp-row"
              title={`${MCP_TRANSPORT_LABELS[server.transport]} · ${MCP_SCOPE_LABELS[server.scope]}${server.enabled ? '' : ' · inaktiv'}`}
              onClick={store.openMcpEditor}
            >
              <span
                className="status-dot"
                style={{
                  background: server.enabled ? '#3fd17a' : '#5a6b78',
                  boxShadow: server.enabled ? '0 0 7px #3fd17a' : 'none'
                }}
              />
              <span className="mcp-row-name">{server.name}</span>
              <span className="mcp-row-tag">{server.transport}</span>
            </button>
          ))
        )}
      </div>

      <div className="side-sep" />


      <div className="side-caption" style={{ paddingTop: 10 }}>
        <span>Navigation</span>
      </div>
      <div className="side-list" style={{ paddingBottom: 8 }}>
        <button
          type="button"
          className={`nav-row ${hash === '#/inbox' ? 'active' : ''}`}
          onClick={() => {
            window.location.hash = '#/inbox'
          }}
          title="Ideen und Artefakte verwalten"
        >
          <span className="nav-icon">📥</span>
          <div className="info">
            <div className="name">Ideen-Inbox</div>
            <div className="summary">Notizen · Dateien · Links</div>
          </div>
        </button>
        <button
          type="button"
          className={`nav-row ${hash !== '#/inbox' ? 'active' : ''}`}
          onClick={() => {
            window.location.hash = ''
          }}
          title="Agent-Workspace"
        >
          <span className="nav-icon">▦</span>
          <div className="info">
            <div className="name">Workspace</div>
            <div className="summary">Agents &amp; Terminals</div>
          </div>
        </button>
      </div>

      <div className="side-sep" />

      <div className="side-caption" style={{ paddingTop: 10 }}>
        <span>Workspace-Profile</span>
        <button type="button" className="icon-btn-sm" title="Neues Profil" aria-label="Neues Workspace-Profil" onClick={store.openEditorNew}>
          ＋
        </button>
      </div>
      <div className="side-list" style={{ paddingBottom: 14 }}>
        {store.profiles.map((p) => (
          <button
            type="button"
            key={p.id}
            className={`profile-row ${p.id === store.activeProfileId ? 'active' : ''}`}
            onClick={() => void store.selectProfile(p.id)}
            onDoubleClick={() => store.openEditor(p)}
            title="Klick: aktivieren · Doppelklick: bearbeiten"
            aria-pressed={p.id === store.activeProfileId}
          >
            <span className="profile-rail" />
            <div className="info">
              <div className="name">{p.name}</div>
              <div className="summary">{profileSummary(p)}</div>
            </div>
            <span className="profile-count">{profileAgentCount(p)}</span>
          </button>
        ))}
      </div>
    </aside>
  )
}
