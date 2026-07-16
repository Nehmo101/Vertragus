import { useEffect, useState } from 'react'
import {
  useAppStore,
  workspaceAgentHistory,
  workspaceUserAttention,
  type WorkspaceUserAttention
} from '@renderer/store/useAppStore'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import { profileSummary, profileAgentCount } from '@renderer/components/TitleBar'
import { githubAuthPresentation, hasUsableGithubAuth } from '@renderer/store/githubAuth'
import type { AgentProviderId, ProviderHealth, ProviderId } from '@shared/providers'
import type { RetroSyncStatus } from '@shared/retroSync'
import type { InboxSpeechStatus } from '@shared/inboxSpeech'
import { MCP_SCOPE_LABELS, MCP_TRANSPORT_LABELS } from '@shared/mcp'
import { middleEarthWorkspaceName, middleEarthWorkspaceBlurb } from '@shared/workspaceNames'
import LoreName from '@renderer/components/LoreName'
import { deriveRemoteApprovals } from '@shared/remote'
import { ResizeHandle } from '@renderer/components/ResizeHandle'
import { selectPanelLayout, useLayoutStore } from '@renderer/store/layoutStore'

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
  const configurable = id !== 'github' && id !== 'cloudflare'
  const providerId = configurable ? (id as AgentProviderId) : undefined
  const enabled = providerId ? store.providerEnabled[providerId] : true
  const loginRunning = store.agents.some(
    (agent) => agent.taskId === `auth:${id}` && agent.status === 'running'
  )
  return (
    <div className={`provider-row ${enabled ? '' : 'disabled'}`}>
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
      {providerId && (
        <button
          type="button"
          className={`provider-enable-btn ${enabled ? 'enabled' : 'disabled'}`}
          title={`${theme.label} global ${enabled ? 'deaktivieren' : 'aktivieren'}`}
          aria-pressed={enabled}
          onClick={() => store.setProviderEnabled(providerId, !enabled)}
        >
          {enabled ? 'An' : 'Aus'}
        </button>
      )}
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

function GithubRow(): JSX.Element {
  const store = useAppStore()
  const theme = PROVIDER_THEME.github
  const auth = store.githubAuth
  const presentation = githubAuthPresentation(auth)
  const loginRunning = store.agents.some(
    (agent) => agent.taskId === 'auth:github' && agent.status === 'running'
  )
  const connected = hasUsableGithubAuth(auth)
  const reauth = Boolean(auth?.needsReauth)
  const busy = store.githubAuthBusy || loginRunning
  const color = connected ? 'var(--run)' : 'var(--wait)'

  return (
    <div className="provider-row">
      <span className="chip sz-26" style={{ background: theme.bg, color: theme.fg }}>
        {theme.mono}
      </span>
      <div className="info">
        <div className="name">{theme.label}</div>
        <div className="detail" title={presentation.detail}>
          {presentation.detail}
        </div>
      </div>
      <span className="status-wrap">
        <span className="status-dot" style={{ background: color, boxShadow: `0 0 7px ${color}` }} />
        <span className="status-label" style={{ color: connected ? 'var(--run-text)' : 'var(--wait-text)' }}>
          {presentation.label}
        </span>
      </span>
      <button
        type="button"
        className="provider-login-btn"
        disabled={busy}
        title={
          loginRunning
            ? 'Login läuft bereits im Provider-Terminal'
            : connected
              ? 'GitHub-Verbindung abmelden'
              : reauth
                ? 'GitHub-Berechtigungen erneuern'
                : 'GitHub verbinden'
        }
        aria-label={connected ? 'GitHub abmelden' : reauth ? 'GitHub-Berechtigungen erneuern' : 'GitHub verbinden'}
        onClick={() => void (connected ? store.githubLogout() : store.githubLogin())}
      >
        {busy ? 'Offen' : connected ? 'Abmelden' : reauth ? 'Erneuern' : 'Login'}
      </button>
    </div>
  )
}


function retroSyncDetail(status: RetroSyncStatus | undefined, error: string | undefined): string {
  if (error) return error
  if (!status) return '…'
  if (status.lastError) return status.lastError
  if (!status.enabled) return `Ziel: ${status.repoOwner}/${status.repoName}@${status.branch}`
  const lastExport = status.lastExportAt
    ? new Date(status.lastExportAt).toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    : 'noch nie'
  return `${status.queued} in Warteschlange · zuletzt ${lastExport}`
}

function RetroSyncRow(): JSX.Element {
  const store = useAppStore()
  const connected = hasUsableGithubAuth(store.githubAuth)
  const [status, setStatus] = useState<RetroSyncStatus | undefined>()
  const [draft, setDraft] = useState({ repoOwner: '', repoName: '', branch: '' })
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const reload = async (): Promise<void> => {
    try {
      const next = await window.orca.retro.syncStatus()
      setStatus(next)
      setDraft({ repoOwner: next.repoOwner, repoName: next.repoName, branch: next.branch })
    } catch {
      // Status ist rein informativ; Fehler blockieren die Sidebar nicht.
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  const toggle = async (): Promise<void> => {
    if (!status) return
    setBusy(true)
    setError(undefined)
    try {
      await window.orca.setConfig('retroSync.enabled', !status.enabled)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const saveTarget = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await window.orca.setConfig('retroSync.repoOwner', draft.repoOwner)
      await window.orca.setConfig('retroSync.repoName', draft.repoName)
      await window.orca.setConfig('retroSync.branch', draft.branch)
      setEditing(false)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const flush = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      setStatus(await window.orca.retro.syncFlush())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const active = Boolean(status?.enabled)
  const dot = active ? 'var(--run)' : 'var(--sage)'
  const detail = retroSyncDetail(status, error)

  return (
    <>
      <div className="provider-row">
        <span className="chip sz-26" style={{ background: 'var(--sage)', color: '#10221a' }}>
          ↻
        </span>
        <div className="info">
          <div
            className="name"
            title="Retros nach jedem Lauf in den zentralen Retro-Branch exportieren · Doppelklick: Ziel bearbeiten"
            onDoubleClick={() => setEditing((value) => !value)}
          >
            Retro-Sync
          </div>
          <div className="detail" title={detail}>
            {detail}
          </div>
        </div>
        <span className="status-wrap">
          <span
            className="status-dot"
            style={{ background: dot, boxShadow: active ? `0 0 7px ${dot}` : 'none' }}
          />
          <span className="status-label" style={{ color: active ? 'var(--run-text)' : 'var(--sage-strong)' }}>
            {active ? 'Aktiv' : 'Aus'}
          </span>
        </span>
        <button
          type="button"
          className={`provider-enable-btn ${active ? 'enabled' : 'disabled'}`}
          disabled={busy || !status || (!connected && !active)}
          title={
            connected || active
              ? `Retro-Sync ${active ? 'deaktivieren' : 'aktivieren'}`
              : 'Zuerst GitHub verbinden'
          }
          aria-pressed={active}
          onClick={() => void toggle()}
        >
          {active ? 'An' : 'Aus'}
        </button>
        {active && (
          <button
            type="button"
            className="provider-login-btn"
            disabled={busy || !connected}
            title={connected ? 'Warteschlange jetzt exportieren' : 'Zuerst GitHub verbinden'}
            aria-label="Retro-Warteschlange jetzt exportieren"
            onClick={() => void flush()}
          >
            Sync
          </button>
        )}
      </div>
      {editing && (
        <div className="provider-row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <input
            value={draft.repoOwner}
            placeholder="Owner"
            aria-label="Retro-Sync GitHub-Owner"
            style={{ flex: '1 1 30%', minWidth: 0 }}
            onChange={(event) => setDraft({ ...draft, repoOwner: event.target.value })}
          />
          <input
            value={draft.repoName}
            placeholder="Repo"
            aria-label="Retro-Sync GitHub-Repository"
            style={{ flex: '1 1 30%', minWidth: 0 }}
            onChange={(event) => setDraft({ ...draft, repoName: event.target.value })}
          />
          <input
            value={draft.branch}
            placeholder="Branch"
            aria-label="Retro-Sync Branch"
            style={{ flex: '1 1 20%', minWidth: 0 }}
            onChange={(event) => setDraft({ ...draft, branch: event.target.value })}
          />
          <button
            type="button"
            className="provider-login-btn"
            disabled={busy}
            onClick={() => void saveTarget()}
          >
            OK
          </button>
        </div>
      )}
    </>
  )
}

function SpeechRow(): JSX.Element {
  const store = useAppStore()
  const revision = store.speechStatusRevision
  const [status, setStatus] = useState<InboxSpeechStatus | undefined>()

  useEffect(() => {
    let cancelled = false
    void window.orca.inboxSpeech
      .status()
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch(() => {
        // Status ist rein informativ; Fehler blockieren die Sidebar nicht.
      })
    return () => {
      cancelled = true
    }
  }, [revision])

  const configured = Boolean(status?.configured)
  const dot = configured ? 'var(--run)' : 'var(--wait)'
  const detail = status
    ? configured
      ? `Modell ${status.model} · ${status.language}`
      : 'Kein API-Schlüssel hinterlegt'
    : '…'

  return (
    <div className="provider-row">
      <span className="chip sz-26" style={{ background: 'var(--sage)', color: '#10221a' }}>
        🎙
      </span>
      <div className="info">
        <div className="name" title="Sprache-zu-Text für Voice-Leiste und Ideen-Inbox">
          Sprachsteuerung
        </div>
        <div className="detail" title={detail}>
          {detail}
        </div>
      </div>
      <span className="status-wrap">
        <span className="status-dot" style={{ background: dot, boxShadow: `0 0 7px ${dot}` }} />
        <span
          className="status-label"
          style={{ color: configured ? 'var(--run-text)' : 'var(--wait-text)' }}
        >
          {configured ? 'Bereit' : 'Kein Schlüssel'}
        </span>
      </span>
      <button
        type="button"
        className="provider-login-btn"
        title="Sprache-zu-Text einrichten (API-Schlüssel, Modell, Sprache)"
        aria-label="Sprache-zu-Text-Einstellungen öffnen"
        onClick={() => store.openSpeechSettings()}
      >
        {configured ? 'Konto' : 'Einrichten'}
      </button>
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

export const SIDEBAR_SECTION_ORDER = [
  'workspace-profiles',
  'profile-workspaces',
  'navigation',
  'mcp',
  'ai-providers',
  'infrastructure'
] as const

type SidebarSectionId = (typeof SIDEBAR_SECTION_ORDER)[number]

function attentionText(attention: WorkspaceUserAttention): string {
  return attention.source === 'orchestrator'
    ? 'Orchestrator wartet auf deine Rückmeldung.'
    : `${attention.agentName ?? 'Ein Subagent'} wartet auf deine Rückmeldung.`
}

type SidebarStore = ReturnType<typeof useAppStore.getState>

interface SidebarViewProps {
  store: SidebarStore
  width?: number
  collapsed?: boolean
  onToggle?: () => void
}

export function SidebarView({
  store,
  width,
  collapsed = false,
  onToggle
}: SidebarViewProps): JSX.Element {
  const hash = useHashRoute()
  const aiIds: ProviderId[] = ['claude', 'codex', 'cursor', 'copilot', 'ollama']
  const onlineCount = aiIds.filter(
    (id) => store.providerEnabled[id as AgentProviderId] && store.health.find((h) => h.id === id)?.available
  ).length
  const runningByProfile = new Map<string, number>()
  for (const agent of store.agents) {
    if (!agent.profileId || (agent.status !== 'running' && agent.status !== 'waiting')) continue
    runningByProfile.set(agent.profileId, (runningByProfile.get(agent.profileId) ?? 0) + 1)
  }
  const agentHistory = workspaceAgentHistory(store)
  const approvalCount = deriveRemoteApprovals(Object.values(store.orchestrators)).length

  const sections: Record<SidebarSectionId, JSX.Element> = {
    'workspace-profiles': (
      <section key="workspace-profiles" data-sidebar-section="workspace-profiles">
        <div className="side-caption" style={{ paddingTop: 10 }}>
          <span>Workspace-Profile</span>
          <button type="button" className="icon-btn-sm" title="Neues Profil" aria-label="Neues Workspace-Profil" onClick={store.openEditorNew}>
            ＋
          </button>
          {store.profiles.find((profile) => profile.id === store.activeProfileId) && (
            <>
              <button
                type="button"
                className="icon-btn-sm"
                title="Aktives Profil duplizieren"
                aria-label="Aktives Workspace-Profil duplizieren"
                onClick={() => {
                  const profile = store.profiles.find((item) => item.id === store.activeProfileId)
                  if (profile) void store.duplicateProfile(profile.id)
                }}
              >
                ⧉
              </button>
              <button
                type="button"
                className="icon-btn-sm"
                title="Weiteren Workspace aus diesem Profil starten"
                aria-label="Weiteren Workspace starten"
                onClick={() => void store.startAll()}
              >
                ▶
              </button>
            </>
          )}
        </div>
        <div className="side-list" style={{ paddingBottom: 14 }}>
          {store.profiles.map((profile) => {
            const attention = workspaceUserAttention(store, profile.id)
            const attentionLabel = attention ? attentionText(attention) : undefined
            return (
              <div className="profile-row-item" key={profile.id}>
                <button
                  type="button"
                  className={`profile-row ${profile.id === store.activeProfileId ? 'active' : ''} ${attention ? 'workspace-needs-user-attention' : ''}`}
                  data-user-attention={attention?.source}
                  onClick={() => void store.selectProfile(profile.id)}
                  onDoubleClick={() => store.openEditor(profile)}
                  title={`Klick: aktivieren · Doppelklick: bearbeiten${attentionLabel ? ` · ${attentionLabel}` : ''}`}
                  aria-label={attentionLabel ? `${profile.name}. ${attentionLabel}` : undefined}
                  aria-pressed={profile.id === store.activeProfileId}
                >
                  <span className="profile-rail" />
                  <div className="info">
                    <div className="name">{profile.name}</div>
                    <div className="summary">{profileSummary(profile)}</div>
                  </div>
                  {attention && <span className="workspace-attention-indicator" aria-hidden="true" />}
                  <span className={`profile-count ${runningByProfile.has(profile.id) ? 'running' : ''}`}>
                    {runningByProfile.has(profile.id)
                      ? `${runningByProfile.get(profile.id)} aktiv`
                      : profileAgentCount(profile)}
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-btn-sm profile-duplicate-action"
                  title={`Profil „${profile.name}“ duplizieren`}
                  aria-label={`Workspace-Profil „${profile.name}“ duplizieren`}
                  onClick={() => void store.duplicateProfile(profile.id)}
                >
                  ⧉
                </button>
              </div>
            )
          })}
        </div>
        <div className="side-sep" />
      </section>
    ),
    'profile-workspaces': (
      <section key="profile-workspaces" data-sidebar-section="profile-workspaces">
        <div className="side-caption workspace-session-caption">
          <span>Profil-Workspaces</span>
        </div>
        <div className="side-list workspace-session-list">
          {store.workspaceSessions
            .filter((session) => session.profileId === store.activeProfileId)
            .map((session) => {
              const running = store.agents.filter(
                (agent) =>
                  agent.workspaceSessionId === session.id &&
                  (agent.status === 'running' || agent.status === 'waiting')
              ).length
              const name = session.name || middleEarthWorkspaceName(session.sequence)
              const label = `W${session.sequence} ${name}`
              const attention = workspaceUserAttention(store, session.profileId, session.id)
              const attentionLabel = attention ? attentionText(attention) : undefined
              return (
                <div className="workspace-session-row" key={session.id}>
                  <button
                    type="button"
                    className={`workspace-session-select ${session.id === store.activeWorkspaceSessionId ? 'active' : ''} ${attention ? 'workspace-needs-user-attention' : ''}`}
                    data-user-attention={attention?.source}
                    title={attentionLabel}
                    aria-label={`${label}${attentionLabel ? `. ${attentionLabel}` : ''}`}
                    onClick={() => void store.selectWorkspaceSession(session.profileId, session.id)}
                  >
                    <LoreName
                      name={name}
                      label={label}
                      blurb={middleEarthWorkspaceBlurb(name)}
                      className="workspace-session-name"
                    />
                    {attention && <span className="workspace-attention-indicator" aria-hidden="true" />}
                    <small>{running > 0 ? `${running} aktiv` : 'inaktiv'}</small>
                  </button>
                  <button
                    type="button"
                    className="workspace-session-remove"
                    title="Diesen Workspace-Lauf entfernen"
                    aria-label={`${label} entfernen`}
                    onClick={() => void store.removeWorkspaceSession(session.profileId, session.id)}
                  >
                    ×
                  </button>
                </div>
              )
            })}
        </div>
        {agentHistory.length > 0 && (
          <>
            <div className="side-caption agent-history-caption" style={{ paddingTop: 10 }}>
              <span>Agent-Verlauf</span>
              <span className="agent-history-count">{agentHistory.length} gespeichert</span>
            </div>
            <div className="side-list agent-history-list">
              {agentHistory.map((agent) => {
                const provider = PROVIDER_THEME[agent.provider]
                const failed = agent.status === 'error'
                return (
                  <button
                    type="button"
                    key={agent.id}
                    className={`agent-history-row ${store.reopenedAgentIds.includes(agent.id) ? 'open' : ''}`}
                    title={`${agent.role} - Chat wieder aufrufen`}
                    onClick={() => {
                      store.reopenAgent(agent.id)
                      window.location.hash = ''
                    }}
                  >
                    <span className="chip sz-26" style={{ background: provider.bg, color: provider.fg }}>
                      {provider.mono}
                    </span>
                    <span className="agent-history-info">
                      <span className="agent-history-name">{agent.name}</span>
                      <span className="agent-history-role">{agent.role}</span>
                    </span>
                    <span className={`agent-history-status ${failed ? 'failed' : 'done'}`}>
                      {failed ? 'Fehler' : 'Beendet'}
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        )}
        <div className="side-sep" />
      </section>
    ),
    navigation: (
      <section key="navigation" data-sidebar-section="navigation">
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
              <div className="summary">Notizen · Sprache · Dateien</div>
            </div>
          </button>
          <button
            type="button"
            className={`nav-row ${hash === '' || hash === '#' ? 'active' : ''}`}
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
          <button
            type="button"
            className={`nav-row ${hash === '#/approvals' ? 'active' : ''}`}
            onClick={() => { window.location.hash = '#/approvals' }}
            title="Alle wartenden Entscheidungen und Laufbudgets"
          >
            <span className="nav-icon">✓</span>
            <div className="info">
              <div className="name">Approval-Inbox</div>
              <div className="summary">{approvalCount ? `${approvalCount} offen` : 'Alles entschieden'}</div>
            </div>
          </button>
          <button
            type="button"
            className={`nav-row ${hash === '#/changes' ? 'active' : ''}`}
            onClick={() => { window.location.hash = '#/changes' }}
            title="Verifizierte Diffs, Integrationsstatus und PR-Freigaben"
          >
            <span className="nav-icon">⇄</span>
            <div className="info">
              <div className="name">Diff &amp; Merge</div>
              <div className="summary">Commits · Gates · PR</div>
            </div>
          </button>
          <button
            type="button"
            className="nav-row"
            onClick={() => void store.exportDiagnostics()}
            title="Letzten redigierten Workspace-Run als JSONL exportieren"
          >
            <span className="nav-icon">⇩</span>
            <div className="info">
              <div className="name">Diagnose exportieren</div>
              <div className="summary">Run-Historie · ohne Secrets</div>
            </div>
          </button>
        </div>
        <div className="side-sep" />
      </section>
    ),
    mcp: (
      <section key="mcp" data-sidebar-section="mcp">
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
      </section>
    ),
    'ai-providers': (
      <section key="ai-providers" data-sidebar-section="ai-providers">
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
        <div className="side-sep" />
      </section>
    ),
    infrastructure: (
      <section key="infrastructure" data-sidebar-section="infrastructure">
        <div className="side-caption" style={{ paddingTop: 14 }}>
          <span>Infrastruktur</span>
        </div>
        <div className="side-list">
          <GithubRow />
          <RetroSyncRow />
          <SpeechRow />
          <ProviderRow id="cloudflare" />
        </div>
      </section>
    )
  }

  return (
    <aside
      id="sidebar-left-panel"
      className={`sidebar layout-panel ${collapsed ? 'panel-collapsed' : ''}`}
      style={collapsed ? undefined : { width }}
      aria-label="Linke Seitenleiste"
    >
      {onToggle && (
        <div className="panel-control-row panel-control-row-left">
          <button
            type="button"
            className="panel-collapse-button"
            aria-controls="sidebar-left-content"
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Linke Seitenleiste ausklappen' : 'Linke Seitenleiste einklappen'}
            title={collapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'}
            onClick={onToggle}
          >
            {collapsed ? '›' : '‹'}
          </button>
        </div>
      )}
      {!collapsed && (
        <div id="sidebar-left-content" className="panel-scroll-content">
          {SIDEBAR_SECTION_ORDER.map((section) => sections[section])}
        </div>
      )}
    </aside>
  )
}

export default function Sidebar(): JSX.Element {
  const store = useAppStore()
  const layout = useLayoutStore(selectPanelLayout('sidebar-left'))
  const toggleCollapsed = useLayoutStore((state) => state.toggleCollapsed)

  return (
    <>
      <SidebarView
        store={store}
        width={layout.width}
        collapsed={layout.collapsed}
        onToggle={() => toggleCollapsed('sidebar-left')}
      />
      {!layout.collapsed && (
        <ResizeHandle
          panelId="sidebar-left"
          direction="right"
          ariaLabel="Breite der linken Seitenleiste ändern"
        />
      )}
    </>
  )
}
