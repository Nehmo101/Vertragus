import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ApnsConfigStatus,
  ApnsEnvironment,
  DeviceInfo,
  PairingChallenge,
  RemoteCapability,
  RemoteStatus
} from '@shared/remote'
import type { WorkspaceSessionSummary } from '@shared/orchestrator'

const INITIAL_STATUS: RemoteStatus = {
  enabled: false,
  gatewayRunning: false,
  tunnel: 'disabled',
  deviceCount: 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function RemotePanel(): JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<RemoteStatus>(INITIAL_STATUS)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [challenge, setChallenge] = useState<PairingChallenge>()
  const [hostname, setHostname] = useState('')
  const [tunnelToken, setTunnelToken] = useState('')
  const [admin, setAdmin] = useState(false)
  const [diffAccess, setDiffAccess] = useState(false)
  const [pushAccess, setPushAccess] = useState(false)
  const [speechAccess, setSpeechAccess] = useState(false)
  const [toolApproval, setToolApproval] = useState(false)
  const [budgetAccess, setBudgetAccess] = useState(false)
  const [taskControl, setTaskControl] = useState(false)
  const [replanAccess, setReplanAccess] = useState(false)
  const [fallbackAccess, setFallbackAccess] = useState(false)
  const [actorId, setActorId] = useState('owner')
  const [actorName, setActorName] = useState('Owner')
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string }>>([])
  const [sessions, setSessions] = useState<WorkspaceSessionSummary[]>([])
  const [selectedSessions, setSelectedSessions] = useState<string[]>([])
  const [goalProfiles, setGoalProfiles] = useState<string[]>([])
  const [accessTeamDomain, setAccessTeamDomain] = useState('')
  const [accessAudience, setAccessAudience] = useState('')
  const [quickTunnel, setQuickTunnel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [apnsStatus, setApnsStatus] = useState<ApnsConfigStatus>({ configured: false })
  const [apnsTeamId, setApnsTeamId] = useState('')
  const [apnsKeyId, setApnsKeyId] = useState('')
  const [apnsBundleId, setApnsBundleId] = useState('')
  const [apnsEnvironment, setApnsEnvironment] = useState<ApnsEnvironment>('production')
  const [apnsP8, setApnsP8] = useState('')

  const refresh = async (): Promise<void> => {
    const next = await window.vertragus.remote.status()
    setStatus(next)
    setDevices(await window.vertragus.remote.listDevices())
  }

  useEffect(() => {
    const unsubscribe = window.vertragus.remote.onStatus(setStatus)
    const unsubscribeSessions = window.vertragus.workspaceSessions.onChanged(setSessions)
    void Promise.all([
      window.vertragus.remote.status(), window.vertragus.remote.listDevices(),
      window.vertragus.listProfiles(), window.vertragus.workspaceSessions.list()
    ])
      .then(([nextStatus, nextDevices, nextProfiles, nextSessions]) => {
        setStatus(nextStatus)
        setDevices(nextDevices)
        setProfiles(nextProfiles.map(({ id, name }) => ({ id, name })))
        setSessions(nextSessions)
      })
      .catch((value) => setError(errorMessage(value)))
    return () => { unsubscribe(); unsubscribeSessions() }
  }, [])

  const applyApnsStatus = (status: ApnsConfigStatus): void => {
    setApnsStatus(status)
    if (status.configured) {
      setApnsTeamId(status.teamId ?? '')
      setApnsKeyId(status.keyId ?? '')
      setApnsBundleId(status.bundleId ?? '')
      setApnsEnvironment(status.environment ?? 'production')
    }
  }

  useEffect(() => {
    window.vertragus.remote.getApnsConfigStatus().then(applyApnsStatus).catch(() => undefined)
  }, [])

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await operation()
      await refresh()
    } catch (value) {
      setError(errorMessage(value))
    } finally {
      setBusy(false)
    }
  }

  const activeDevices = devices.filter((device) => !device.revokedAt)

  return (
    <main className="remote-panel">
      <header className="remote-panel-head">
        <div>
          <span className="eyebrow">{t('remote.eyebrow')}</span>
          <h1>{t('remote.title')}</h1>
          <p>{t('remote.sub')}</p>
        </div>
        <span className={`remote-state state-${status.tunnel}`}>
          {status.enabled ? t('remote.stateActive', { tunnel: status.tunnel }) : t('remote.stateOff')}
        </span>
      </header>

      {error && <div className="remote-error" role="alert">{error}</div>}

      <section className="remote-card remote-setup">
        <div>
          <h2>{t('remote.tunnel.title')}</h2>
          <p>
            {t('remote.tunnel.desc')}
          </p>
        </div>
        {!status.enabled ? (
          <div className="remote-form">
            <label className="remote-checkbox">
              <input type="checkbox" checked={quickTunnel} onChange={(event) => setQuickTunnel(event.target.checked)} />
              {t('remote.tunnel.quick')}
            </label>
            <label>
              {t('remote.tunnel.hostname')}
              <input
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                placeholder="mission.example.com"
                autoComplete="off"
                disabled={quickTunnel}
              />
            </label>
            <label>
              {t('remote.tunnel.token')}
              <input
                value={tunnelToken}
                onChange={(event) => setTunnelToken(event.target.value)}
                type="password"
                placeholder={t('remote.tunnel.tokenPlaceholder')}
                autoComplete="new-password"
                disabled={quickTunnel}
              />
            </label>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void run(async () => {
                await window.vertragus.remote.enable({
                  hostname: quickTunnel ? undefined : hostname.trim() || undefined,
                  tunnelToken: quickTunnel ? undefined : tunnelToken.trim() || undefined,
                  quickTunnel,
                  accessTeamDomain: accessTeamDomain.trim() || undefined,
                  accessAudience: accessAudience.trim() || undefined
                })
                setTunnelToken('')
              })}
            >
              {t('remote.tunnel.enable')}
            </button>
            <label>
              {t('remote.tunnel.accessTeamDomain')}
              <input value={accessTeamDomain} onChange={(event) => setAccessTeamDomain(event.target.value)} placeholder="https://team.cloudflareaccess.com" autoComplete="off" />
            </label>
            <label>
              {t('remote.tunnel.accessAudience')}
              <input value={accessAudience} onChange={(event) => setAccessAudience(event.target.value)} autoComplete="off" />
            </label>
          </div>
        ) : (
          <div className="remote-online-details">
            <code>{status.publicUrl ?? `127.0.0.1:${status.gatewayPort ?? '…'}`}</code>
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => void run(async () => {
                await window.vertragus.remote.disable()
                setChallenge(undefined)
              })}
            >
              {t('remote.tunnel.kill')}
            </button>
          </div>
        )}
      </section>

      <details className="remote-card remote-apns">
        <summary>
          <h2>APNs Push (iOS)</h2>
          <span className={`remote-state state-${apnsStatus.configured ? 'online' : 'disabled'}`}>
            {apnsStatus.configured ? 'Konfiguriert' : 'Nicht konfiguriert'}
          </span>
        </summary>
        <p>
          Signierschlüssel für native iOS-Push. Wird verschlüsselt auf diesem Gerät gespeichert
          (safeStorage) und nie im Klartext zurückgegeben. Ohne Konfiguration bleibt Web-Push aktiv.
        </p>
        {apnsStatus.configured && (
          <small className="remote-apns-status">
            Aktiv · Team {apnsStatus.teamId} · Key {apnsStatus.keyId} · {apnsStatus.bundleId} · {apnsStatus.environment}
          </small>
        )}
        <div className="remote-form">
          <label>
            Team ID
            <input
              value={apnsTeamId}
              onChange={(event) => setApnsTeamId(event.target.value)}
              placeholder="ABCDE12345"
              autoComplete="off"
              maxLength={64}
            />
          </label>
          <label>
            Key ID
            <input
              value={apnsKeyId}
              onChange={(event) => setApnsKeyId(event.target.value)}
              placeholder="KEY1234567"
              autoComplete="off"
              maxLength={64}
            />
          </label>
          <label>
            Bundle ID
            <input
              value={apnsBundleId}
              onChange={(event) => setApnsBundleId(event.target.value)}
              placeholder="com.example.MissionControl"
              autoComplete="off"
              maxLength={200}
            />
          </label>
          <label>
            Umgebung
            <select
              value={apnsEnvironment}
              onChange={(event) => setApnsEnvironment(event.target.value as ApnsEnvironment)}
            >
              <option value="production">Production</option>
              <option value="sandbox">Sandbox</option>
            </select>
          </label>
          <label>
            .p8-Schlüssel
            <textarea
              value={apnsP8}
              onChange={(event) => setApnsP8(event.target.value)}
              placeholder={apnsStatus.configured
                ? 'Gespeichert · nur zum Ersetzen erneut einfügen'
                : '-----BEGIN PRIVATE KEY-----'}
              autoComplete="off"
              rows={4}
              spellCheck={false}
            />
          </label>
          <div className="remote-apns-actions">
            <button
              type="button"
              className="btn primary"
              disabled={
                busy || !apnsTeamId.trim() || !apnsKeyId.trim() || !apnsBundleId.trim() || !apnsP8.trim()
              }
              onClick={() => void run(async () => {
                const status = await window.vertragus.remote.setApnsConfig({
                  teamId: apnsTeamId.trim(),
                  keyId: apnsKeyId.trim(),
                  p8: apnsP8.trim(),
                  bundleId: apnsBundleId.trim(),
                  environment: apnsEnvironment
                })
                applyApnsStatus(status)
                setApnsP8('')
              })}
            >
              Speichern
            </button>
            {apnsStatus.configured && (
              <button
                type="button"
                className="btn danger"
                disabled={busy}
                onClick={() => void run(async () => {
                  applyApnsStatus(await window.vertragus.remote.clearApnsConfig())
                  setApnsP8('')
                })}
              >
                Entfernen
              </button>
            )}
          </div>
        </div>
      </details>

      <div className="remote-grid">
        <section className="remote-card">
          <h2>{t('remote.pairing.title')}</h2>
          <p>{t('remote.pairing.desc')}</p>
          <label className="remote-checkbox">
            <input type="checkbox" checked={admin} onChange={(event) => setAdmin(event.target.checked)} />
            {t('remote.pairing.admin')}
          </label>
          <label className="remote-checkbox">
            <input type="checkbox" checked={diffAccess} onChange={(event) => setDiffAccess(event.target.checked)} />
            {t('remote.pairing.diff')}
          </label>
          <label className="remote-checkbox">
            <input type="checkbox" checked={pushAccess} onChange={(event) => setPushAccess(event.target.checked)} />
            {t('remote.pairing.push')}
          </label>
          <label className="remote-checkbox">
            <input type="checkbox" checked={speechAccess} onChange={(event) => setSpeechAccess(event.target.checked)} />
            {t('remote.pairing.speech')}
          </label>
          <label className="remote-checkbox">
            <input type="checkbox" checked={toolApproval} onChange={(event) => setToolApproval(event.target.checked)} />
            {t('remote.pairing.tools')}
          </label>
          <label className="remote-checkbox">
            <input type="checkbox" checked={budgetAccess} onChange={(event) => setBudgetAccess(event.target.checked)} />
            {t('remote.pairing.budget')}
          </label>
          <label className="remote-checkbox">
            <input type="checkbox" checked={taskControl} onChange={(event) => setTaskControl(event.target.checked)} />
            {t('remote.pairing.taskControl')}
          </label>
          <label className="remote-checkbox">
            <input type="checkbox" checked={replanAccess} onChange={(event) => setReplanAccess(event.target.checked)} />
            {t('remote.pairing.replan')}
          </label>
          <label className="remote-checkbox">
            <input type="checkbox" checked={fallbackAccess} onChange={(event) => setFallbackAccess(event.target.checked)} />
            {t('remote.pairing.fallback')}
          </label>
          <label>{t('remote.pairing.actorId')}<input value={actorId} onChange={(event) => setActorId(event.target.value)} maxLength={160} /></label>
          <label>{t('remote.pairing.actorName')}<input value={actorName} onChange={(event) => setActorName(event.target.value)} maxLength={160} /></label>
          <div className="remote-scope-list">
            <strong>{t('remote.pairing.scopes')}</strong>
            {profiles.map((profile) => (
              <div key={profile.id} className="remote-scope">
                <span>{profile.name}</span>
                {sessions.filter((session) => session.profileId === profile.id).map((session) => (
                  <label className="remote-checkbox" key={session.id}>
                    <input
                      type="checkbox"
                      checked={selectedSessions.includes(session.id)}
                      onChange={(event) => setSelectedSessions((current) => event.target.checked
                        ? [...current, session.id] : current.filter((id) => id !== session.id))}
                    />
                    {t('remote.pairing.session', { name: session.name })}
                  </label>
                ))}
                <label className="remote-checkbox">
                  <input
                    type="checkbox"
                    checked={goalProfiles.includes(profile.id)}
                    onChange={(event) => setGoalProfiles((current) => event.target.checked
                      ? [...current, profile.id] : current.filter((id) => id !== profile.id))}
                  />
                  {t('remote.pairing.allowGoals')}
                </label>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn primary"
            disabled={
              busy || !status.enabled || status.tunnel !== 'online' || !actorId.trim() ||
              (selectedSessions.length === 0 && goalProfiles.length === 0)
            }
            onClick={() => void run(async () => {
              const capabilities: RemoteCapability[] = ['read', 'steer']
              if (admin) capabilities.push('admin')
              if (diffAccess) capabilities.push('diff')
              if (pushAccess) capabilities.push('push')
              if (speechAccess) capabilities.push('speech')
              if (toolApproval) capabilities.push('approve-tools')
              if (budgetAccess) capabilities.push('budget')
              if (taskControl) capabilities.push('task-control')
              if (replanAccess) capabilities.push('replan')
              if (fallbackAccess) capabilities.push('provider-fallback')
              const scopes = profiles.flatMap((profile) => {
                const sessionIds = sessions
                  .filter((session) => session.profileId === profile.id && selectedSessions.includes(session.id))
                  .map((session) => session.id)
                const allowGoalSubmit = goalProfiles.includes(profile.id)
                return sessionIds.length > 0 || allowGoalSubmit
                  ? [{ profileId: profile.id, sessionIds, allowGoalSubmit }]
                  : []
              })
              setChallenge(await window.vertragus.remote.pairStart({
                capabilities,
                actor: { id: actorId.trim(), displayName: actorName.trim() || actorId.trim() },
                scopes
              }))
            })}
          >
            {t('remote.pairing.generate')}
          </button>
          {challenge && (
            <div className="remote-pairing">
              {challenge.qrDataUrl && <img src={challenge.qrDataUrl} alt={t('remote.pairing.qrAlt')} />}
              <strong>{challenge.code}</strong>
              <small>{t('remote.pairing.validUntil', { time: new Date(challenge.expiresAt).toLocaleTimeString() })}</small>
              {challenge.pairingUrl && <code>{challenge.pairingUrl}</code>}
            </div>
          )}
        </section>

        <section className="remote-card">
          <h2>{t('remote.devices.title')}</h2>
          {activeDevices.length === 0 ? (
            <p>{t('remote.devices.empty')}</p>
          ) : activeDevices.map((device) => (
            <div className="remote-device" key={device.id}>
              <div>
                <strong>{device.name}</strong>
                <small>{device.actor.displayName} · {device.capabilities.join(' · ')}</small>
                <small>{t('remote.devices.meta', { n: device.scopes.reduce((sum, scope) => sum + scope.sessionIds.length, 0), date: new Date(device.createdAt).toLocaleDateString() })}</small>
              </div>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void run(async () => { await window.vertragus.remote.revokeDevice(device.id) })}
              >
                {t('remote.devices.revoke')}
              </button>
            </div>
          ))}
        </section>
      </div>
    </main>
  )
}
