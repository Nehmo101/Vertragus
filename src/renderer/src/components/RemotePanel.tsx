import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { REMOTE_CAPABILITIES } from '@shared/remote'
import type {
  ApnsConfigStatus,
  ApnsEnvironment,
  DeviceInfo,
  PairingChallenge,
  RemoteCapability,
  RemoteStatus
} from '@shared/remote'
import type { WorkspaceSessionSummary } from '@shared/orchestrator'
import {
  REMOTE_PRESET_CAPABILITIES,
  normalizeCapabilities,
  presetForCapabilities,
  type RemotePresetId
} from './remotePresets'
import ErrorCard from './ui/ErrorCard'
import styles from './RemotePanel.module.css'

const INITIAL_STATUS: RemoteStatus = {
  enabled: false,
  gatewayRunning: false,
  tunnel: 'disabled',
  deviceCount: 0
}

/** Existing locale keys for the nine previously exposed capability checkboxes. */
const CAPABILITY_LABEL_KEYS: Partial<Record<RemoteCapability, string>> = {
  admin: 'remote.pairing.admin',
  diff: 'remote.pairing.diff',
  push: 'remote.pairing.push',
  speech: 'remote.pairing.speech',
  'approve-tools': 'remote.pairing.tools',
  budget: 'remote.pairing.budget',
  'task-control': 'remote.pairing.taskControl',
  replan: 'remote.pairing.replan',
  'provider-fallback': 'remote.pairing.fallback'
}

/** Preset card ids; title/desc live in the locale files under remote.presets.<id>. */
const PRESET_CARD_IDS: Array<RemotePresetId | 'custom'> = ['observe', 'approve', 'full', 'custom']

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
  const [capabilities, setCapabilities] = useState<RemoteCapability[]>(
    () => [...REMOTE_PRESET_CAPABILITIES.observe]
  )
  const [customSelected, setCustomSelected] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
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

  const loadAll = async (): Promise<void> => {
    const [nextStatus, nextDevices, nextProfiles, nextSessions] = await Promise.all([
      window.vertragus.remote.status(), window.vertragus.remote.listDevices(),
      window.vertragus.listProfiles(), window.vertragus.workspaceSessions.list()
    ])
    setStatus(nextStatus)
    setDevices(nextDevices)
    setProfiles(nextProfiles.map(({ id, name }) => ({ id, name })))
    setSessions(nextSessions)
  }

  /** Retry for the error card: clear the error and reload the panel data. */
  const retryLoad = (): void => {
    setError(undefined)
    void loadAll().catch((value) => setError(errorMessage(value)))
  }

  useEffect(() => {
    const unsubscribe = window.vertragus.remote.onStatus(setStatus)
    const unsubscribeSessions = window.vertragus.workspaceSessions.onChanged(setSessions)
    void Promise.resolve()
      .then(() => loadAll())
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

  const derivedPreset = presetForCapabilities(capabilities)
  const activePreset: RemotePresetId | 'custom' = customSelected ? 'custom' : derivedPreset
  const advancedExpanded = advancedOpen || activePreset === 'custom'

  const selectPreset = (id: RemotePresetId | 'custom'): void => {
    if (id === 'custom') {
      setCustomSelected(true)
      setAdvancedOpen(true)
      return
    }
    setCustomSelected(false)
    setCapabilities([...REMOTE_PRESET_CAPABILITIES[id]])
  }

  const toggleCapability = (capability: RemoteCapability, enabled: boolean): void => {
    setCapabilities((current) => {
      const next = new Set(current)
      if (enabled) next.add(capability)
      else next.delete(capability)
      next.add('read')
      return normalizeCapabilities(next)
    })
    setCustomSelected(false)
  }

  const capabilityLabel = (capability: RemoteCapability): string => {
    const key = CAPABILITY_LABEL_KEYS[capability]
    if (key) return t(key)
    if (capability === 'read') return t('remote.pairing.read')
    return t('remote.pairing.steer')
  }

  return (
    <main className="remote-panel mission-surface">
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

      {error && (
        <ErrorCard
          title={t('ui.actionFailed')}
          detail={error}
          onRetry={retryLoad}
          retryLabel={t('remote.reload')}
          retryDisabled={busy}
        />
      )}

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
          <h2>{t('remote.apns.title')}</h2>
          <span className={`remote-state state-${apnsStatus.configured ? 'online' : 'disabled'}`}>
            {apnsStatus.configured ? t('remote.apns.configured') : t('remote.apns.notConfigured')}
          </span>
        </summary>
        <p>{t('remote.apns.desc')}</p>
        {apnsStatus.configured && (
          <small className="remote-apns-status">
            {t('remote.apns.active', {
              teamId: apnsStatus.teamId,
              keyId: apnsStatus.keyId,
              bundleId: apnsStatus.bundleId,
              environment: apnsStatus.environment
            })}
          </small>
        )}
        <div className="remote-form">
          <label>
            {t('remote.apns.teamId')}
            <input
              value={apnsTeamId}
              onChange={(event) => setApnsTeamId(event.target.value)}
              placeholder="ABCDE12345"
              autoComplete="off"
              maxLength={64}
            />
          </label>
          <label>
            {t('remote.apns.keyId')}
            <input
              value={apnsKeyId}
              onChange={(event) => setApnsKeyId(event.target.value)}
              placeholder="KEY1234567"
              autoComplete="off"
              maxLength={64}
            />
          </label>
          <label>
            {t('remote.apns.bundleId')}
            <input
              value={apnsBundleId}
              onChange={(event) => setApnsBundleId(event.target.value)}
              placeholder="com.example.MissionControl"
              autoComplete="off"
              maxLength={200}
            />
          </label>
          <label>
            {t('remote.apns.environment')}
            <select
              value={apnsEnvironment}
              onChange={(event) => setApnsEnvironment(event.target.value as ApnsEnvironment)}
            >
              <option value="production">Production</option>
              <option value="sandbox">Sandbox</option>
            </select>
          </label>
          <label>
            {t('remote.apns.p8Key')}
            <textarea
              value={apnsP8}
              onChange={(event) => setApnsP8(event.target.value)}
              placeholder={apnsStatus.configured
                ? t('remote.apns.p8Stored')
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
              {t('remote.apns.save')}
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
                {t('remote.apns.remove')}
              </button>
            )}
          </div>
        </div>
      </details>

      <div className="remote-grid">
        <section className="remote-card">
          <h2>{t('remote.pairing.title')}</h2>
          <p>{t('remote.pairing.desc')}</p>
          <div className={styles.presetGroup} role="radiogroup" aria-label={t('remote.presets.aria')}>
            {PRESET_CARD_IDS.map((cardId) => (
              <label
                key={cardId}
                className={
                  activePreset === cardId
                    ? `${styles.presetCard} ${styles.presetCardActive}`
                    : styles.presetCard
                }
              >
                <input
                  type="radio"
                  name="remote-pairing-preset"
                  className={styles.presetRadio}
                  value={cardId}
                  checked={activePreset === cardId}
                  onChange={() => selectPreset(cardId)}
                />
                <span className={styles.presetTitle}>{t(`remote.presets.${cardId}.title`)}</span>
                <span className={styles.presetDesc}>{t(`remote.presets.${cardId}.desc`)}</span>
              </label>
            ))}
          </div>
          <details
            className={styles.advanced}
            open={advancedExpanded}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary className={styles.advancedSummary}>{t('remote.advanced.title')}</summary>
            <div className={styles.advancedBody}>
              <p className={styles.advancedHint}>{t('remote.advanced.hint')}</p>
              {REMOTE_CAPABILITIES.map((capability) => (
                <label className="remote-checkbox" key={capability}>
                  <input
                    type="checkbox"
                    checked={capabilities.includes(capability)}
                    disabled={capability === 'read'}
                    onChange={(event) => toggleCapability(capability, event.target.checked)}
                  />
                  {capabilityLabel(capability)}
                </label>
              ))}
              <div className="remote-scope-list" role="list">
                <strong>{t('remote.pairing.scopes')}</strong>
                {profiles.map((profile) => (
                  <div key={profile.id} className="remote-scope" role="listitem">
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
            </div>
          </details>
          <label>{t('remote.pairing.actorId')}<input value={actorId} onChange={(event) => setActorId(event.target.value)} maxLength={160} /></label>
          <label>{t('remote.pairing.actorName')}<input value={actorName} onChange={(event) => setActorName(event.target.value)} maxLength={160} /></label>
          <button
            type="button"
            className="btn primary"
            disabled={
              busy || !status.enabled || status.tunnel !== 'online' || !actorId.trim() ||
              (selectedSessions.length === 0 && goalProfiles.length === 0)
            }
            onClick={() => void run(async () => {
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
                capabilities: normalizeCapabilities(capabilities),
                actor: { id: actorId.trim(), displayName: actorName.trim() || actorId.trim() },
                scopes
              }))
            })}
          >
            {t('remote.pairing.generate')}
          </button>
          {selectedSessions.length === 0 && goalProfiles.length === 0 && (
            <small className={styles.scopeHint}>{t('remote.pairing.scopeHint')}</small>
          )}
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
