import { useEffect, useState } from 'react'
import type { DeviceInfo, PairingChallenge, RemoteCapability, RemoteStatus } from '@shared/remote'

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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = async (): Promise<void> => {
    const next = await window.orca.remote.status()
    setStatus(next)
    setDevices(await window.orca.remote.listDevices())
  }

  useEffect(() => {
    const unsubscribe = window.orca.remote.onStatus(setStatus)
    void Promise.all([window.orca.remote.status(), window.orca.remote.listDevices()])
      .then(([nextStatus, nextDevices]) => {
        setStatus(nextStatus)
        setDevices(nextDevices)
      })
      .catch((value) => setError(errorMessage(value)))
    return unsubscribe
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
            <label>
              Öffentlicher Hostname
              <input
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                placeholder="mission.example.com"
                autoComplete="off"
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
              />
            </label>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void run(async () => {
                await window.orca.remote.enable({
                  hostname: hostname.trim() || undefined,
                  tunnelToken: tunnelToken.trim() || undefined
                })
                setTunnelToken('')
              })}
            >
              Sicher aktivieren
            </button>
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
          <button
            type="button"
            className="btn primary"
            disabled={busy || !status.enabled || status.tunnel !== 'online'}
            onClick={() => void run(async () => {
              const capabilities: RemoteCapability[] = ['read', 'steer']
              if (admin) capabilities.push('admin')
              setChallenge(await window.orca.remote.pairStart({ capabilities }))
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
                <small>{device.capabilities.join(' · ')} · gekoppelt {new Date(device.createdAt).toLocaleDateString()}</small>
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
