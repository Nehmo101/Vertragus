/**
 * The remote-access section of the settings window.
 *
 * Off by default, and enabling it is a deliberate act: the section spells out
 * that a connected device runs agents in yolo mode (remote code execution),
 * offers only Tailscale-first bind addresses, gates `0.0.0.0` behind a typed
 * confirmation, and shows the pairing QR plus the live connected-device list
 * with a per-device disconnect. All the security-relevant state (running,
 * error, clients) is pushed over `ev:remote`, so the section stays live as
 * phones come and go.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BindOption, RemoteClientInfo, RemoteStatus } from '@shared/remote/types'
import { pairingQrSvg } from './qr'
import type { VertragusAppApi } from '../../../preload'

const ALL_INTERFACES = '0.0.0.0'

export function RemoteSection(): React.JSX.Element | null {
  const { t } = useTranslation()
  const bridge = useMemo<VertragusAppApi | undefined>(() => window.vertragus?.app, [])
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [interfaces, setInterfaces] = useState<BindOption[]>([])
  const [clients, setClients] = useState<RemoteClientInfo[]>([])
  const [allConfirmed, setAllConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)

  const refreshClients = useCallback(() => {
    bridge?.listRemoteClients().then(setClients, () => undefined)
  }, [bridge])

  useEffect(() => {
    if (!bridge) return
    bridge.getRemote().then(setStatus, () => undefined)
    bridge.listRemoteInterfaces().then(setInterfaces, () => undefined)
    refreshClients()
    const off = bridge.onRemote((next) => {
      setStatus(next)
      refreshClients()
    })
    return off
  }, [bridge, refreshClients])

  const apply = useCallback(
    async (patch: { enabled?: boolean; bindAddress?: string; port?: number }) => {
      if (!bridge) return
      setBusy(true)
      try {
        setStatus(await bridge.setRemote(patch))
        refreshClients()
      } finally {
        setBusy(false)
      }
    },
    [bridge, refreshClients]
  )

  if (!bridge || !status) return null

  const bindValue = interfaces.find((option) => option.address === statusBindAddress(status))?.address ?? ''
  const wantsAll = bindValue === ALL_INTERFACES
  const enableBlocked = wantsAll && !allConfirmed

  return (
    <section className="st-remote">
      <h2 className="st-section-label">{t('settings.remote')}</h2>

      <label className="st-switch">
        <input
          type="checkbox"
          className="st-switch-input"
          checked={status.enabled}
          disabled={busy || (!status.enabled && enableBlocked)}
          onChange={(event) => apply({ enabled: event.target.checked })}
        />
        <span className="st-switch-text">
          <span className="st-switch-label">{t('settings.remoteEnable')}</span>
          <span className="st-hint">
            {status.enabled ? t('settings.remoteEnableHint') : t('settings.remoteEnableOffHint')}
          </span>
        </span>
      </label>

      <p className="st-hint is-warn">{t('settings.remoteWarnExec')}</p>

      <div className="st-pair">
        <div className="st-field">
          <span className="st-label">{t('settings.remoteBind')}</span>
          <select
            className="st-input"
            value={bindValue}
            disabled={busy}
            onChange={(event) => {
              setAllConfirmed(false)
              apply({ bindAddress: event.target.value })
            }}
          >
            {interfaces.map((option) => (
              <option key={option.address} value={option.address}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="st-hint">{t('settings.remoteBindHint')}</span>
        </div>
        <div className="st-field">
          <span className="st-label">{t('settings.remotePort')}</span>
          <input
            className="st-input"
            type="number"
            value={status.port}
            min={1}
            max={65535}
            disabled={busy}
            onChange={(event) => apply({ port: Number(event.target.value) })}
          />
        </div>
      </div>

      {wantsAll ? (
        <label className="st-switch st-remote-danger">
          <input
            type="checkbox"
            className="st-switch-input"
            checked={allConfirmed}
            onChange={(event) => setAllConfirmed(event.target.checked)}
          />
          <span className="st-switch-text">
            <span className="st-hint is-warn">{t('settings.remoteAllWarning')}</span>
            <span className="st-switch-label">{t('settings.remoteAllConfirm')}</span>
          </span>
        </label>
      ) : null}

      {status.error ? <p className="st-error">{status.error}</p> : null}

      {status.running && status.pairingUrl ? (
        <div className="st-remote-pairing">
          <p className="st-hint">{t('settings.remoteScan')}</p>
          <div
            className="st-qr"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: pairingQrSvg(status.pairingUrl) }}
          />
          <label className="st-label">{t('settings.remotePairingUrl')}</label>
          <input className="st-input st-mono" readOnly value={status.pairingUrl} />
          <button type="button" className="st-secondary" disabled={busy} onClick={() => bridge.regenerateRemoteToken().then(setStatus)}>
            {t('settings.remoteRegenerate')}
          </button>
          <span className="st-hint">{t('settings.remoteRegenerateHint')}</span>
        </div>
      ) : null}

      {status.running ? (
        <div className="st-remote-clients">
          <span className="st-label">{t('settings.remoteClients')}</span>
          {clients.length === 0 ? (
            <span className="st-hint">{t('settings.remoteClientsEmpty')}</span>
          ) : (
            <ul className="st-client-list">
              {clients.map((client) => (
                <li key={client.id} className="st-client">
                  <span className="st-mono">{client.remoteAddress}</span>
                  <button
                    type="button"
                    className="st-ghost"
                    onClick={() => bridge.revokeRemoteClient(client.id).then(refreshClients)}
                  >
                    {t('settings.remoteRevoke')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  )
}

/** The controller reports the bound address on `address`. */
function statusBindAddress(status: RemoteStatus): string | undefined {
  return status.address
}
