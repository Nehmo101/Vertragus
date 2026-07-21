import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  useAppStore,
  workspaceAgentHistory,
  workspaceTaskSummary,
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
import { workspacePlaceName, workspacePlaceBlurb } from '@shared/workspaceNames'
import LoreName from '@renderer/components/LoreName'
import WorkspaceTaskSummary from '@renderer/components/WorkspaceTaskSummary'
import { deriveRemoteApprovals } from '@shared/remote'
import { ResizeHandle } from '@renderer/components/ResizeHandle'
import { selectPanelLayout, useLayoutStore } from '@renderer/store/layoutStore'
import styles from './Sidebar.module.css'
import { workspaceRunPresentation } from './workspaceRunStatus'

interface RowStatus {
  /** i18n key of the status label. */
  label: string
  dot: string
  text: string
}

function statusFor(id: ProviderId, h: ProviderHealth | undefined): RowStatus {
  if (!h) return { label: 'sidebar.provider.checking', dot: 'var(--wait)', text: 'var(--wait-text)' }
  if (!h.available) return { label: 'sidebar.provider.missing', dot: 'var(--err)', text: 'var(--err-text)' }
  switch (h.connection) {
    case 'connected':
      return { label: 'sidebar.provider.connected', dot: 'var(--run)', text: 'var(--run-text)' }
    case 'disconnected':
      return { label: 'sidebar.provider.login', dot: 'var(--wait)', text: 'var(--wait-text)' }
    case 'local':
      return { label: 'sidebar.provider.local', dot: 'var(--run)', text: 'var(--run-text)' }
    default:
      return {
        label: id === 'cloudflare' ? 'sidebar.provider.ready' : 'sidebar.provider.installed',
        dot: 'var(--sage)',
        text: 'var(--sage-strong)'
      }
  }
}

function detailFor(t: TFunction, h: ProviderHealth | undefined): string {
  if (!h) return '…'
  if (!h.available) return t('sidebar.provider.notInstalled')
  return h.detail ?? h.version ?? t('sidebar.provider.installedDetail')
}

function ProviderRow({ id }: { id: ProviderId }): JSX.Element {
  const { t } = useTranslation()
  const store = useAppStore(
    useShallow((s) => ({
      health: s.health,
      providerEnabled: s.providerEnabled,
      setProviderEnabled: s.setProviderEnabled,
      loginProvider: s.loginProvider,
      // Derive the boolean so usage-only agent ticks don't re-render the row.
      loginRunning: s.agents.some(
        (agent) => agent.taskId === `auth:${id}` && agent.status === 'running'
      )
    }))
  )
  const theme = PROVIDER_THEME[id]
  const h = store.health.find((x) => x.id === id)
  const st = statusFor(id, h)
  const configurable = id !== 'github' && id !== 'cloudflare'
  const providerId = configurable ? (id as AgentProviderId) : undefined
  const enabled = providerId ? store.providerEnabled[providerId] : true
  const loginRunning = store.loginRunning
  return (
    <div className={`provider-row ${enabled ? '' : 'disabled'}`}>
      <span className="chip sz-26" style={{ background: theme.bg, color: theme.fg }}>
        {theme.mono}
      </span>
      <div className="info">
        <div className="name">{theme.label}</div>
        <div className="detail" title={detailFor(t, h)}>
          {detailFor(t, h)}
        </div>
      </div>
      <span className="status-wrap">
        <span
          className="status-dot"
          style={{ background: st.dot, boxShadow: `0 0 7px ${st.dot}` }}
        />
        <span className="status-label" style={{ color: st.text }}>
          {t(st.label)}
        </span>
      </span>
      {providerId && (
        <button
          type="button"
          className={`provider-enable-btn ${enabled ? 'enabled' : 'disabled'}`}
          title={
            enabled
              ? t('sidebar.provider.disableGlobal', { name: theme.label })
              : t('sidebar.provider.enableGlobal', { name: theme.label })
          }
          aria-pressed={enabled}
          onClick={() => store.setProviderEnabled(providerId, !enabled)}
        >
          {enabled ? t('sidebar.on') : t('sidebar.off')}
        </button>
      )}
      {h?.available && h.canLogin && (
        <button
          type="button"
          className="provider-login-btn"
          disabled={loginRunning}
          title={
            loginRunning
              ? t('sidebar.provider.loginRunning')
              : t('sidebar.provider.loginTitle', { label: h.loginLabel })
          }
          aria-label={h.loginLabel ?? t('sidebar.provider.connect', { name: theme.label })}
          onClick={() => void store.loginProvider(id)}
        >
          {loginRunning
            ? t('sidebar.provider.open')
            : h.connection === 'connected'
              ? t('sidebar.provider.account')
              : id === 'ollama'
                ? t('sidebar.provider.cloud')
                : t('sidebar.provider.login')}
        </button>
      )}
    </div>
  )
}

function GithubRow(): JSX.Element {
  const { t } = useTranslation()
  const store = useAppStore(
    useShallow((s) => ({
      githubAuth: s.githubAuth,
      githubAuthBusy: s.githubAuthBusy,
      githubLogin: s.githubLogin,
      githubLogout: s.githubLogout,
      loginRunning: s.agents.some(
        (agent) => agent.taskId === 'auth:github' && agent.status === 'running'
      )
    }))
  )
  const theme = PROVIDER_THEME.github
  const auth = store.githubAuth
  const presentation = githubAuthPresentation(auth)
  const loginRunning = store.loginRunning
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
            ? t('sidebar.provider.loginRunning')
            : connected
              ? t('sidebar.github.logoutTitle')
              : reauth
                ? t('sidebar.github.reauth')
                : t('sidebar.github.connect')
        }
        aria-label={
          connected
            ? t('sidebar.github.logoutAria')
            : reauth
              ? t('sidebar.github.reauth')
              : t('sidebar.github.connect')
        }
        onClick={() => void (connected ? store.githubLogout() : store.githubLogin())}
      >
        {busy
          ? t('sidebar.provider.open')
          : connected
            ? t('sidebar.github.logout')
            : reauth
              ? t('sidebar.github.renew')
              : t('sidebar.provider.login')}
      </button>
    </div>
  )
}


function retroSyncDetail(
  t: TFunction,
  status: RetroSyncStatus | undefined,
  error: string | undefined
): string {
  if (error) return error
  if (!status) return '…'
  if (status.lastError) return status.lastError
  if (!status.enabled)
    return t('sidebar.retro.target', {
      target: `${status.repoOwner}/${status.repoName}@${status.branch}`
    })
  const lastExport = status.lastExportAt
    ? new Date(status.lastExportAt).toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    : t('sidebar.retro.never')
  return t('sidebar.retro.queue', { queued: status.queued, last: lastExport })
}

function RetroSyncRow(): JSX.Element {
  const { t } = useTranslation()
  const store = useAppStore(useShallow((s) => ({ githubAuth: s.githubAuth })))
  const connected = hasUsableGithubAuth(store.githubAuth)
  const [status, setStatus] = useState<RetroSyncStatus | undefined>()
  const [draft, setDraft] = useState({ repoOwner: '', repoName: '', branch: '' })
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const reload = async (): Promise<void> => {
    try {
      const next = await window.vertragus.retro.syncStatus()
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
      await window.vertragus.setConfig('retroSync.enabled', !status.enabled)
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
      await window.vertragus.setConfig('retroSync.repoOwner', draft.repoOwner)
      await window.vertragus.setConfig('retroSync.repoName', draft.repoName)
      await window.vertragus.setConfig('retroSync.branch', draft.branch)
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
      setStatus(await window.vertragus.retro.syncFlush())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const active = Boolean(status?.enabled)
  const dot = active ? 'var(--run)' : 'var(--sage)'
  const detail = retroSyncDetail(t, status, error)

  return (
    <>
      <div className="provider-row">
        <span className="chip sz-26" style={{ background: 'var(--sage)', color: '#10221a' }}>
          ↻
        </span>
        <div className="info">
          <div
            className="name"
            title={t('sidebar.retro.nameTitle')}
            onDoubleClick={() => setEditing((value) => !value)}
          >
            {t('sidebar.retro.name')}
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
            {active ? t('sidebar.retro.active') : t('sidebar.off')}
          </span>
        </span>
        <button
          type="button"
          className={`provider-enable-btn ${active ? 'enabled' : 'disabled'}`}
          disabled={busy || !status || (!connected && !active)}
          title={
            connected || active
              ? active
                ? t('sidebar.retro.disable')
                : t('sidebar.retro.enable')
              : t('sidebar.retro.githubFirst')
          }
          aria-pressed={active}
          onClick={() => void toggle()}
        >
          {active ? t('sidebar.on') : t('sidebar.off')}
        </button>
        {active && (
          <button
            type="button"
            className="provider-login-btn"
            disabled={busy || !connected}
            title={connected ? t('sidebar.retro.flushTitle') : t('sidebar.retro.githubFirst')}
            aria-label={t('sidebar.retro.flushAria')}
            onClick={() => void flush()}
          >
            {t('sidebar.retro.sync')}
          </button>
        )}
      </div>
      {editing && (
        <div className="provider-row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <input
            value={draft.repoOwner}
            placeholder={t('sidebar.retro.owner')}
            aria-label={t('sidebar.retro.ownerAria')}
            style={{ flex: '1 1 30%', minWidth: 0 }}
            onChange={(event) => setDraft({ ...draft, repoOwner: event.target.value })}
          />
          <input
            value={draft.repoName}
            placeholder={t('sidebar.retro.repo')}
            aria-label={t('sidebar.retro.repoAria')}
            style={{ flex: '1 1 30%', minWidth: 0 }}
            onChange={(event) => setDraft({ ...draft, repoName: event.target.value })}
          />
          <input
            value={draft.branch}
            placeholder={t('sidebar.retro.branch')}
            aria-label={t('sidebar.retro.branchAria')}
            style={{ flex: '1 1 20%', minWidth: 0 }}
            onChange={(event) => setDraft({ ...draft, branch: event.target.value })}
          />
          <button
            type="button"
            className="provider-login-btn"
            disabled={busy}
            onClick={() => void saveTarget()}
          >
            {t('sidebar.ok')}
          </button>
        </div>
      )}
    </>
  )
}

function SpeechRow(): JSX.Element {
  const { t } = useTranslation()
  const store = useAppStore(
    useShallow((s) => ({
      openSpeechSettings: s.openSpeechSettings,
      speechStatusRevision: s.speechStatusRevision
    }))
  )
  const revision = store.speechStatusRevision
  const [status, setStatus] = useState<InboxSpeechStatus | undefined>()

  useEffect(() => {
    let cancelled = false
    void window.vertragus.inboxSpeech
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
      ? t('sidebar.speech.model', { model: status.model, language: status.language })
      : t('sidebar.speech.noKey')
    : '…'

  return (
    <div className="provider-row">
      <span className="chip sz-26" style={{ background: 'var(--sage)', color: '#10221a' }}>
        🎙
      </span>
      <div className="info">
        <div className="name" title={t('sidebar.speech.nameTitle')}>
          {t('sidebar.speech.name')}
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
          {configured ? t('sidebar.provider.ready') : t('sidebar.speech.keyMissing')}
        </span>
      </span>
      <button
        type="button"
        className="provider-login-btn"
        title={t('sidebar.speech.setupTitle')}
        aria-label={t('sidebar.speech.openAria')}
        onClick={() => store.openSpeechSettings()}
      >
        {configured ? t('sidebar.provider.account') : t('sidebar.speech.setup')}
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

function attentionText(t: TFunction, attention: WorkspaceUserAttention): string {
  return attention.source === 'orchestrator'
    ? t('sidebar.attention.orchestrator')
    : t('sidebar.attention.agent', {
        name: attention.agentName ?? t('sidebar.attention.someAgent')
      })
}

type SidebarStore = ReturnType<typeof useAppStore.getState>

// Exactly the store fields SidebarView (and the helpers it calls) reads. Narrowing
// the prop from the full store lets the parent subscribe via a shallow selector, so
// SidebarView no longer re-renders on unrelated store changes (toast, gitInfo, theme…).
export type SidebarViewState = Pick<
  SidebarStore,
  | 'activeProfileId'
  | 'activeWorkspaceSessionId'
  | 'agents'
  | 'duplicateProfile'
  | 'exportDiagnostics'
  | 'health'
  | 'mcpServers'
  | 'openEditor'
  | 'openEditorNew'
  | 'openMcpEditor'
  | 'orchestrators'
  | 'profiles'
  | 'providerEnabled'
  | 'refreshHealth'
  | 'removeWorkspaceSession'
  | 'reopenAgent'
  | 'reopenedAgentIds'
  | 'selectProfile'
  | 'selectWorkspaceSession'
  | 'startAll'
  | 'workspaceSessions'
>

interface SidebarViewProps {
  store: SidebarViewState
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
  const { t } = useTranslation()
  const hash = useHashRoute()
  const aiIds: ProviderId[] = ['claude', 'kimi', 'codex', 'cursor', 'copilot', 'ollama']
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
          <span>{t('sidebar.profiles.caption')}</span>
          <button type="button" className="icon-btn-sm" title={t('sidebar.profiles.newTitle')} aria-label={t('sidebar.profiles.newAria')} onClick={store.openEditorNew}>
            ＋
          </button>
          {store.profiles.find((profile) => profile.id === store.activeProfileId) && (
            <>
              <button
                type="button"
                className="icon-btn-sm"
                title={t('sidebar.profiles.duplicateActiveTitle')}
                aria-label={t('sidebar.profiles.duplicateActiveAria')}
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
                title={t('sidebar.profiles.startAnotherTitle')}
                aria-label={t('sidebar.profiles.startAnotherAria')}
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
            const attentionLabel = attention ? attentionText(t, attention) : undefined
            return (
              <div className="profile-row-item" key={profile.id}>
                <button
                  type="button"
                  className={`profile-row ${profile.id === store.activeProfileId ? 'active' : ''} ${attention ? 'workspace-needs-user-attention' : ''}`}
                  data-user-attention={attention?.source}
                  onClick={() => void store.selectProfile(profile.id)}
                  onDoubleClick={() => store.openEditor(profile)}
                  title={`${t('sidebar.profiles.rowTitle')}${attentionLabel ? ` · ${attentionLabel}` : ''}`}
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
                      ? t('sidebar.profiles.activeCount', { n: runningByProfile.get(profile.id) })
                      : profileAgentCount(profile)}
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-btn-sm profile-duplicate-action"
                  title={t('sidebar.profiles.duplicateTitle', { name: profile.name })}
                  aria-label={t('sidebar.profiles.duplicateAria', { name: profile.name })}
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
          <span>{t('sidebar.sessions.caption')}</span>
        </div>
        <div className="side-list workspace-session-list">
          {store.workspaceSessions
            .filter((session) => session.profileId === store.activeProfileId)
            .map((session) => {
              const sessionAgents = store.agents.filter(
                (agent) => agent.workspaceSessionId === session.id
              )
              const running = sessionAgents.filter(
                (agent) => agent.status === 'running' || agent.status === 'waiting'
              ).length
              const orchestratorAgent = sessionAgents
                .filter((agent) => agent.kind === 'orchestrator')
                .sort((left, right) => right.startedAt - left.startedAt)[0]
              const snapshot = store.orchestrators[session.id] ?? Object.values(store.orchestrators)
                .find((item) =>
                  item.workspaceSessionId === session.id &&
                  (!item.profileId || item.profileId === session.profileId)
                )
              const runStatus = workspaceRunPresentation({
                activeAgents: running,
                terminalStatus: snapshot?.lastRetro?.status,
                orchestratorAgentStatus: orchestratorAgent?.status,
                gitPostProcessingStatus: snapshot?.gitPostProcessing?.status
              })
              const name = session.name || workspacePlaceName(session.sequence)
              const label = `W${session.sequence} ${name}`
              const taskSummary = workspaceTaskSummary(store, session.profileId, session.id)
              const attention = workspaceUserAttention(store, session.profileId, session.id)
              const attentionLabel = attention ? attentionText(t, attention) : undefined
              return (
                <div className="workspace-session-row" key={session.id}>
                  <button
                    type="button"
                    className={`workspace-session-select ${session.id === store.activeWorkspaceSessionId ? 'active' : ''} ${attention ? 'workspace-needs-user-attention' : ''}`}
                    data-user-attention={attention?.source}
                    title={attentionLabel}
                    aria-label={`${label}${taskSummary ? `. ${t('sidebar.sessions.currentTask', { summary: taskSummary })}` : ''}${attentionLabel ? `. ${attentionLabel}` : ''}`}
                    onClick={() => void store.selectWorkspaceSession(session.profileId, session.id)}
                  >
                    <span className="workspace-session-main">
                      <LoreName
                        name={name}
                        label={label}
                        blurb={workspacePlaceBlurb(name)}
                        className="workspace-session-name"
                      />
                      <WorkspaceTaskSummary taskSummary={taskSummary} />
                    </span>
                    {attention && <span className="workspace-attention-indicator" aria-hidden="true" />}
                    <span
                      className={styles.workspaceRunStatus}
                      data-orchestrator-status={runStatus.state}
                      data-tone={runStatus.tone}
                      role="status"
                      aria-label={runStatus.accessibleLabel}
                    >
                      <span className={styles.workspaceRunSymbol} aria-hidden="true">
                        {runStatus.symbol}
                      </span>
                      <span>{runStatus.label}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="workspace-session-remove"
                    title={t('sidebar.sessions.removeTitle')}
                    aria-label={t('sidebar.sessions.removeAria', { label })}
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
              <span>{t('sidebar.history.caption')}</span>
              <span className="agent-history-count">{t('sidebar.history.stored', { n: agentHistory.length })}</span>
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
                    title={t('sidebar.history.reopenTitle', { role: agent.role })}
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
                      {failed ? t('sidebar.history.failed') : t('sidebar.history.done')}
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
          <span>{t('sidebar.nav.caption')}</span>
        </div>
        <div className="side-list" style={{ paddingBottom: 8 }}>
          <button
            type="button"
            className={`nav-row ${hash === '#/inbox' ? 'active' : ''}`}
            onClick={() => {
              window.location.hash = '#/inbox'
            }}
            title={t('sidebar.nav.inboxTitle')}
          >
            <span className="nav-icon">📥</span>
            <div className="info">
              <div className="name">{t('sidebar.nav.inbox')}</div>
              <div className="summary">{t('sidebar.nav.inboxSub')}</div>
            </div>
          </button>
          <button
            type="button"
            className={`nav-row ${hash === '' || hash === '#' ? 'active' : ''}`}
            onClick={() => {
              window.location.hash = ''
            }}
            title={t('sidebar.nav.workspaceTitle')}
          >
            <span className="nav-icon">▦</span>
            <div className="info">
              <div className="name">{t('sidebar.nav.workspace')}</div>
              <div className="summary">{t('sidebar.nav.workspaceSub')}</div>
            </div>
          </button>
          <button
            type="button"
            className={`nav-row ${hash === '#/approvals' ? 'active' : ''}`}
            onClick={() => { window.location.hash = '#/approvals' }}
            title={t('sidebar.nav.approvalsTitle')}
          >
            <span className="nav-icon">✓</span>
            <div className="info">
              <div className="name">{t('sidebar.nav.approvals')}</div>
              <div className="summary">
                {approvalCount
                  ? t('sidebar.nav.openCount', { n: approvalCount })
                  : t('sidebar.nav.allDecided')}
              </div>
            </div>
          </button>
          <button
            type="button"
            className={`nav-row ${hash === '#/changes' ? 'active' : ''}`}
            onClick={() => { window.location.hash = '#/changes' }}
            title={t('sidebar.nav.changesTitle')}
          >
            <span className="nav-icon">⇄</span>
            <div className="info">
              <div className="name">{t('sidebar.nav.changes')}</div>
              <div className="summary">{t('sidebar.nav.changesSub')}</div>
            </div>
          </button>
          <button
            type="button"
            className="nav-row"
            onClick={() => void store.exportDiagnostics()}
            title={t('sidebar.nav.diagTitle')}
          >
            <span className="nav-icon">⇩</span>
            <div className="info">
              <div className="name">{t('sidebar.nav.diag')}</div>
              <div className="summary">{t('sidebar.nav.diagSub')}</div>
            </div>
          </button>
        </div>
        <div className="side-sep" />
      </section>
    ),
    mcp: (
      <section key="mcp" data-sidebar-section="mcp">
        <div className="side-caption" style={{ paddingTop: 14 }}>
          <span>{t('sidebar.mcp.caption')}</span>
          <button
            type="button"
            className="icon-btn-sm"
            title={t('sidebar.mcp.manageTitle')}
            aria-label={t('sidebar.mcp.manageAria')}
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
              title={t('sidebar.mcp.addTitle')}
              onClick={store.openMcpEditor}
            >
              {t('sidebar.mcp.add')}
            </button>
          ) : (
            store.mcpServers.map((server) => (
              <button
                type="button"
                key={server.id}
                className="mcp-row"
                title={`${MCP_TRANSPORT_LABELS[server.transport]} · ${MCP_SCOPE_LABELS[server.scope]}${server.enabled ? '' : ` · ${t('sidebar.mcp.inactive')}`}`}
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
          <span>{t('sidebar.ai.caption')}</span>
          <button
            type="button"
            className="provider-refresh-btn"
            title={t('sidebar.ai.refreshTitle')}
            aria-label={t('sidebar.ai.refreshAria')}
            onClick={() => void store.refreshHealth()}
          >
            ↻
          </button>
          <span className="online-pill">{t('sidebar.ai.online', { n: onlineCount })}</span>
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
          <span>{t('sidebar.infra.caption')}</span>
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
      aria-label={t('sidebar.aria')}
    >
      {onToggle && (
        <div className="panel-control-row panel-control-row-left">
          <button
            type="button"
            className="panel-collapse-button"
            aria-controls="sidebar-left-content"
            aria-expanded={!collapsed}
            aria-label={collapsed ? t('sidebar.expandAria') : t('sidebar.collapseAria')}
            title={collapsed ? t('sidebar.expandTitle') : t('sidebar.collapseTitle')}
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
  const { t } = useTranslation()
  const store = useAppStore(
    useShallow((s): SidebarViewState => ({
      activeProfileId: s.activeProfileId,
      activeWorkspaceSessionId: s.activeWorkspaceSessionId,
      agents: s.agents,
      duplicateProfile: s.duplicateProfile,
      exportDiagnostics: s.exportDiagnostics,
      health: s.health,
      mcpServers: s.mcpServers,
      openEditor: s.openEditor,
      openEditorNew: s.openEditorNew,
      openMcpEditor: s.openMcpEditor,
      orchestrators: s.orchestrators,
      profiles: s.profiles,
      providerEnabled: s.providerEnabled,
      refreshHealth: s.refreshHealth,
      removeWorkspaceSession: s.removeWorkspaceSession,
      reopenAgent: s.reopenAgent,
      reopenedAgentIds: s.reopenedAgentIds,
      selectProfile: s.selectProfile,
      selectWorkspaceSession: s.selectWorkspaceSession,
      startAll: s.startAll,
      workspaceSessions: s.workspaceSessions
    }))
  )
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
          ariaLabel={t('sidebar.resize')}
        />
      )}
    </>
  )
}
