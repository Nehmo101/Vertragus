import { useEffect, useState } from 'react'
import type { DeviceInfo, PairingChallenge, RemoteCapability, RemoteStatus } from '@shared/remote'
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

  const refresh = async (): Promise<void> => {
    const next = await window.orca.remote.status()
    setStatus(next)
    setDevices(await window.orca.remote.listDevices())
  }

  useEffect(() => {
    const unsubscribe = window.orca.remote.onStatus(setStatus)
    const unsubscribeSessions = window.orca.workspaceSessions.onChanged(setSessions)
    void Promise.all([
      window.orca.remote.status(), window.orca.remote.listDevices(),
      window.orca.listProfiles(), window.orca.workspaceSessions.list()
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
          <span className="eyebrow">Mission Control</span>
          <h1>Sichere Remote-Kommandozentrale</h1>
          <p>Live beobachten, vorhandene Gates freigeben und non-yolo Ziele senden.</p>
        </div>
        <span className={`remote-state state-${status.tunnel}`}>
          {status.enabled ? `Remote aktiv · ${status.tunnel}` : 'Remote aus'}
        </span>
      </header>

      {error && <div className="remote-error" role="alert">{error}</div>}

      <section className="remote-card remote-setup">
        <div>
          <h2>Named Cloudflare Tunnel</h2>
          <p>
            Standardmäßig aus. Der Tunnel bindet ausschließlich an das lokale Gateway auf
            127.0.0.1; jeder Daten- und Befehlszugriff benötigt zusätzlich ein Geräte-Token.
          </p>
        </div>
        {!status.enabled ? (
          <div className="remote-form">
            <label className="remote-checkbox">
              <input type="checkbox" checked={quickTunnel} onChange={(event) => setQuickTunnel(event.target.checked)} />
              Ephemeren Quick Tunnel verwenden
            </label>
            <label>
              Öffentlicher Hostname
              <input
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                placeholder="mission.example.com"
                autoComplete="off"
                disabled={quickTunnel}
              />
            </label>
            <label>
              Named-Tunnel-Token
              <input
                value={tunnelToken}
                onChange={(event) => setTunnelToken(event.target.value)}
                type="password"
                placeholder="Bereits gespeichert? Leer lassen"
                autoComplete="new-password"
                disabled={quickTunnel}
              />
            </label>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void run(async () => {
                await window.orca.remote.enable({
                  hostname: quickTunnel ? undefined : hostname.trim() || undefined,
                  tunnelToken: quickTunnel ? undefined : tunnelToken.trim() || undefined,
                  quickTunnel,
                  accessTeamDomain: accessTeamDomain.trim() || undefined,
                  accessAudience: accessAudience.trim() || undefined
                })
                setTunnelToken('')
              })}
            >
              Sicher aktivieren
            </button>
            <label>
              Cloudflare-Access-Team-Domain (optional)
              <input value={accessTeamDomain} onChange={(event) => setAccessTeamDomain(event.target.value)} placeholder="https://team.cloudflareaccess.com" autoComplete="off" />
            </label>
            <label>
              Access-Audience-Tag (optional, immer gemeinsam)
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
                await window.orca.remote.disable()
                setChallenge(undefined)
              })}
            >
              Master-Not-Aus
            </button>
          </div>
        )}
      </section>

      <div className="remote-grid">
        <section className="remote-card">
          <h2>Gerät koppeln</h2>
          <p>Der Einmal-Code läuft nach fünf Minuten ab und kann nur einmal eingelöst werden.</p>
          <label className="remote-checkbox">
            <input type="checkbox" checked={admin} onChange={(event) => setAdmin(event.target.checked)} />
            Admin-Capability für Reset erlauben
          </label>
          <label className="remote-checkbox">
            <input type="checkbox" checked={diffAccess} onChange={(event) => setDiffAccess(event.target.checked)} />
            Mobile Diff-Ansicht erlauben
          </label>
          <label className="remote-checkbox">
            <input type="checkbox" checked={pushAccess} onChange={(event) => setPushAccess(event.target.checked)} />
            Web-Push erlauben
          </label>
          <label className="remote-checkbox">
            <input type="checkbox" checked={speechAccess} onChange={(event) => setSpeechAccess(event.target.checked)} />
            Sprach-Transkription erlauben
          </label>
          <label className="remote-checkbox">
            <input type="checkbox" checked={toolApproval} onChange={(event) => setToolApproval(event.target.checked)} />
            Tool-Freigaben erlauben (approve-tools)
          </label>
          <label className="remote-checkbox">
            <input type="checkbox" checked={budgetAccess} onChange={(event) => setBudgetAccess(event.target.checked)} />
            Fern-Budget-Caps erlauben
          </label>
          <label className="remote-checkbox">
            <input type="checkbox" checked={taskControl} onChange={(event) => setTaskControl(event.target.checked)} />
            Task Pause/Resume erlauben
          </label>
          <label className="remote-checkbox">
            <input type="checkbox" checked={replanAccess} onChange={(event) => setReplanAccess(event.target.checked)} />
            Restriktives Live-Replan erlauben
          </label>
          <label>Account-ID oder Access-E-Mail<input value={actorId} onChange={(event) => setActorId(event.target.value)} maxLength={160} /></label>
          <label>Anzeigename<input value={actorName} onChange={(event) => setActorName(event.target.value)} maxLength={160} /></label>
          <div className="remote-scope-list">
            <strong>Workspace-Scopes (standardmÃ¤ÃŸig keiner)</strong>
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
                    Session {session.name}
                  </label>
                ))}
                <label className="remote-checkbox">
                  <input
                    type="checkbox"
                    checked={goalProfiles.includes(profile.id)}
                    onChange={(event) => setGoalProfiles((current) => event.target.checked
                      ? [...current, profile.id] : current.filter((id) => id !== profile.id))}
                  />
                  Neue Ziele fÃ¼r dieses Profil erlauben
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
              const scopes = profiles.flatMap((profile) => {
                const sessionIds = sessions
                  .filter((session) => session.profileId === profile.id && selectedSessions.includes(session.id))
                  .map((session) => session.id)
                const allowGoalSubmit = goalProfiles.includes(profile.id)
                return sessionIds.length > 0 || allowGoalSubmit
                  ? [{ profileId: profile.id, sessionIds, allowGoalSubmit }]
                  : []
              })
              setChallenge(await window.orca.remote.pairStart({
                capabilities,
                actor: { id: actorId.trim(), displayName: actorName.trim() || actorId.trim() },
                scopes
              }))
            })}
          >
            Pairing-QR erzeugen
          </button>
          {challenge && (
            <div className="remote-pairing">
              {challenge.qrDataUrl && <img src={challenge.qrDataUrl} alt="Mission-Control Pairing-QR" />}
              <strong>{challenge.code}</strong>
              <small>Gültig bis {new Date(challenge.expiresAt).toLocaleTimeString()}</small>
              {challenge.pairingUrl && <code>{challenge.pairingUrl}</code>}
            </div>
          )}
        </section>

        <section className="remote-card">
          <h2>Gekoppelte Geräte</h2>
          {activeDevices.length === 0 ? (
            <p>Noch kein aktives Gerät.</p>
          ) : activeDevices.map((device) => (
            <div className="remote-device" key={device.id}>
              <div>
                <strong>{device.name}</strong>
                <small>{device.actor.displayName} · {device.capabilities.join(' · ')}</small>
                <small>{device.scopes.reduce((sum, scope) => sum + scope.sessionIds.length, 0)} Session-Scope(s) · gekoppelt {new Date(device.createdAt).toLocaleDateString()}</small>
              </div>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void run(async () => { await window.orca.remote.revokeDevice(device.id) })}
              >
                Widerrufen
              </button>
            </div>
          ))}
        </section>
      </div>
    </main>
  )
}
