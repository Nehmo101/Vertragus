/**
 * Settings card for the first-party Chromium extension.
 *
 * Same pairing pattern as remote access: copy a loopback URL, paste it in
 * the extension popup. The token is not a writable settings key — rotation
 * is its own IPC so a renderer cannot invent one.
 *
 * "Install" cannot load the unpacked MV3 into Chromium silently. The host
 * opens chrome://extensions and the folder; the user clicks Load unpacked.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserExtensionStatus } from '@shared/browserExtension'
import type { VertragusAppApi } from '../../../preload'

type InstallNotice = 'opened' | 'folderOnly' | 'missing' | 'revealFailed' | 'failed'

export function BrowserExtensionSection(): React.JSX.Element | null {
  const { t } = useTranslation()
  const bridge = useMemo<VertragusAppApi | undefined>(() => window.vertragus?.app, [])
  const [status, setStatus] = useState<BrowserExtensionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState<InstallNotice | null>(null)

  const refresh = useCallback(() => {
    if (!bridge) return
    void bridge.getBrowserExtension().then(setStatus, () => undefined)
  }, [bridge])

  useEffect(() => {
    if (!bridge) return
    refresh()
    return bridge.onBrowserExtension(setStatus)
  }, [bridge, refresh])

  const copyPairingUrl = useCallback((url: string) => {
    void navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1_500)
      },
      () => undefined
    )
  }, [])

  if (!bridge) return null
  if (!status) {
    return (
      <section className="st-remote">
        <h2 className="st-section-label">{t('settings.browserExtension.title')}</h2>
        <p className="st-hint">{t('common.loading')}</p>
      </section>
    )
  }

  return (
    <section className="st-remote">
      <h2 className="st-section-label">{t('settings.browserExtension.title')}</h2>
      <p className="st-hint">{t('settings.browserExtension.body')}</p>
      <div className="st-remote-status-actions">
        <button
          type="button"
          className="st-primary"
          disabled={busy}
          title={t('settings.browserExtension.installHint')}
          onClick={() => {
            setBusy(true)
            setNotice(null)
            void bridge
              .installBrowserExtension()
              .then((result) => {
                if (!result.ok) {
                  setNotice(result.error === 'missing_extension' ? 'missing' : 'revealFailed')
                  return
                }
                if (status.pairingUrl) copyPairingUrl(status.pairingUrl)
                setNotice(result.openedExtensionsPage ? 'opened' : 'folderOnly')
              }, () => {
                setNotice('failed')
              })
              .finally(() => setBusy(false))
          }}
        >
          {t('settings.browserExtension.install')}
        </button>
      </div>
      <p className="st-hint">{t('settings.browserExtension.installHint')}</p>
      {notice === 'opened' ? (
        <p className="st-hint" role="status">
          {t('settings.browserExtension.installOpened')}
        </p>
      ) : null}
      {notice === 'folderOnly' ? (
        <p className="st-hint" role="status">
          {t('settings.browserExtension.installFolderOnly')}
        </p>
      ) : null}
      {notice === 'missing' ? (
        <p className="st-hint is-warn" role="status">
          {t('settings.browserExtension.missingFolder')}
        </p>
      ) : null}
      {notice === 'revealFailed' ? (
        <p className="st-hint is-warn" role="status">
          {t('settings.browserExtension.installRevealFailed')}
        </p>
      ) : null}
      {notice === 'failed' ? (
        <p className="st-hint is-warn" role="status">
          {t('settings.browserExtension.installFailed')}
        </p>
      ) : null}
      <div className={`st-remote-status ${status.connected ? 'is-ready' : 'is-missing'}`}>
        <span className="st-dot" />
        <div className="st-remote-status-body">
          <span className="st-remote-status-text">
            {status.connected
              ? t('settings.browserExtension.connected', { count: status.clients })
              : t('settings.browserExtension.disconnected')}
          </span>
        </div>
      </div>
      {status.pairingUrl ? (
        <div className="st-remote-pairing">
          <label className="st-label">{t('settings.browserExtension.pairingUrl')}</label>
          <input className="st-input st-mono" readOnly value={status.pairingUrl} />
          <div className="st-remote-pairing-actions">
            <button
              type="button"
              className="st-secondary"
              disabled={busy}
              onClick={() => copyPairingUrl(status.pairingUrl)}
            >
              {copied ? t('settings.browserExtension.copied') : t('settings.browserExtension.copy')}
            </button>
            <button
              type="button"
              className="st-ghost"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void bridge.revealBrowserExtension().finally(() => setBusy(false))
              }}
            >
              {t('settings.browserExtension.reveal')}
            </button>
          </div>
        </div>
      ) : null}
      <p className="st-hint">{t('settings.browserExtension.loadUnpacked')}</p>
      <p className="st-hint">{t('settings.browserExtension.warnYolo')}</p>
      <button
        type="button"
        className="st-ghost"
        disabled={busy}
        title={t('settings.browserExtension.regenerateHint')}
        onClick={() => {
          setBusy(true)
          void bridge.regenerateBrowserExtensionToken().then(setStatus).finally(() => setBusy(false))
        }}
      >
        {t('settings.browserExtension.regenerate')}
      </button>
    </section>
  )
}
