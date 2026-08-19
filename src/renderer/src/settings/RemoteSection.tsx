/**
 * The remote-access section of the settings window.
 *
 * Lives at the top of the sheet so Tailscale setup is the first thing the
 * gear opens onto, not a block buried under glass sliders. Off by default,
 * and enabling it is a deliberate act: the card spells out that a connected
 * device runs agents in yolo mode (remote code execution), shows whether a
 * tailnet interface is up *before* the toggle, offers only Tailscale-first
 * bind addresses (a placeholder row when none is found), gates `0.0.0.0`
 * behind a typed confirmation, and shows the pairing QR plus the live
 * connected-device list with a per-device disconnect. All the
 * security-relevant state (running, error, clients) is pushed over
 * `ev:remote`; interfaces are also polled so starting Tailscale after
 * opening the window is enough.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BindOption, RemoteClientInfo, RemoteStatus } from '@shared/remote/types'
import { pairingQrSvg } from './qr'
import {
  bindOptionLabel,
  detectedTailscaleAddress,
  isAllInterfaces,
  isMissingTailscaleBind,
  REMOTE_INTERFACE_POLL_MS,
  remotePickerOptions,
  selectedBindAddress,
  TAILSCALE_DOWNLOAD_URL
} from './remoteModel'
import type { VertragusAppApi } from '../../../preload'

export function RemoteSection(): React.JSX.Element | null {
  const { t } = useTranslation()
  const bridge = useMemo<VertragusAppApi | undefined>(() => window.vertragus?.app, [])
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [interfaces, setInterfaces] = useState<BindOption[]>([])
  const [clients, setClients] = useState<RemoteClientInfo[]>([])
  const [allConfirmed, setAllConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    if (!bridge) return
    void bridge.getRemote().then(setStatus, () => undefined)
    void bridge.listRemoteInterfaces().then(setInterfaces, () => undefined)
    void bridge.listRemoteClients().then(setClients, () => undefined)
  }, [bridge])

  useEffect(() => {
    if (!bridge) return
    refresh()
    const off = bridge.onRemote((next) => {
      setStatus(next)
      void bridge.listRemoteClients().then(setClients, () => undefined)
    })
    const timer = window.setInterval(refresh, REMOTE_INTERFACE_POLL_MS)
    return () => {
      off()
      window.clearInterval(timer)
    }
  }, [bridge, refresh])

  const apply = useCallback(
    async (patch: { enabled?: boolean; bindAddress?: string; port?: number }) => {
      if (!bridge) return
      setBusy(true)
      try {
        setStatus(await bridge.setRemote(patch))
        refresh()
      } finally {
        setBusy(false)
      }
    },
    [bridge, refresh]
  )

  if (!bridge) return null
  if (!status) {
    return (
      <section className="st-remote">
        <h2 className="st-section-label">{t('settings.remote')}</h2>
        <p className="st-hint">{t('common.loading')}</p>
      </section>
    )
  }

  const picker = remotePickerOptions(interfaces)
  const bindValue = selectedBindAddress(status, picker)
  const tailscaleAddress = detectedTailscaleAddress(status, picker)
  const wantsAll = isAllInterfaces(bindValue)
  const wantsMissingTailscale = isMissingTailscaleBind(bindValue, picker)
  const enableBlocked = (wantsAll && !allConfirmed) || wantsMissingTailscale

  return (
    <section className="st-remote">
      <h2 className="st-section-label">{t('settings.remote')}</h2>

      <div className={`st-remote-status ${tailscaleAddress ? 'is-ready' : 'is-missing'}`}>
        <span className={`st-dot ${tailscaleAddress ? 'is-up-to-date' : 'is-warn'}`} />
        <div className="st-remote-status-body">
          <span className="st-remote-status-text">
            {tailscaleAddress
              ? t('settings.remoteTailscaleReady', { address: tailscaleAddress })
              : t('settings.remoteTailscaleMissing')}
          </span>
          <div className="st-remote-status-actions">
            {tailscaleAddress ? null : (
              <a
                className="st-link"
                href={TAILSCALE_DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer"
              >
                {t('settings.remoteTailscaleInstall')}
              </a>
            )}
            <button type="button" className="st-ghost st-remote-refresh" onClick={refresh}>
              {t('settings.remoteTailscaleRefresh')}
            </button>
          </div>
        </div>
      </div>

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
            {picker.map((option) => (
              <option key={option.address || 'tailscale-auto'} value={option.address}>
                {bindOptionLabel(option, t)}
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
          <button
            type="button"
            className="st-secondary"
            disabled={busy}
            onClick={() => bridge.regenerateRemoteToken().then(setStatus)}
          >
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
                    onClick={() => bridge.revokeRemoteClient(client.id).then(refresh)}
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
