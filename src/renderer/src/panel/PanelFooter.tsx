import { useTranslation } from 'react-i18next'
import { EyeIcon, GearIcon } from './icons'

interface Props {
  yolo: boolean
  onToggleYolo(): void
  onHideAll(): void
  /** Opens the settings window (main/windows/settingsWindow.ts). */
  onSettings(): void
  /** Set when the global hide-all shortcut could not be registered. */
  hotkeyError?: string
  /** True once an update finished downloading — see main/updater.ts. */
  updateReady?: boolean
  /** The version waiting in the badge's tooltip. */
  updateVersion?: string
  onInstallUpdate?(): void
}

/**
 * The footer carries the two switches that act on EVERY window at once: the
 * Yolo master (subagents may act without asking) and hide-all. They are red and
 * quiet respectively — the dangerous one is the one you can see from across the
 * room.
 *
 * Above them, and only when there is something to say, sits the update badge.
 * It appears exactly once per downloaded update and does nothing until it is
 * clicked: restarting takes every running agent with it, so the decision stays
 * with the person whose agents they are.
 */
export function PanelFooter({
  yolo,
  onToggleYolo,
  onHideAll,
  onSettings,
  hotkeyError,
  updateReady = false,
  updateVersion,
  onInstallUpdate
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      {updateReady ? (
        <button
          type="button"
          className="panel-update"
          title={
            updateVersion
              ? t('panel.updateReadyTitle', { version: updateVersion })
              : t('panel.updateReady')
          }
          onClick={onInstallUpdate}
        >
          {t('panel.updateReady')}
        </button>
      ) : null}
      <footer className="panel-footer">
        <button
          type="button"
          className={`panel-yolo${yolo ? ' is-on' : ''}`}
          role="switch"
          aria-checked={yolo}
          title={yolo ? t('panel.yoloOn') : t('panel.yoloOff')}
          onClick={onToggleYolo}
        >
          <span className="panel-yolo-track">
            <span className="panel-yolo-knob" />
          </span>
          <span className="panel-yolo-label">{t('panel.yolo')}</span>
        </button>
        <span className="panel-footer-spacer" />
        <button
          type="button"
          className={`panel-icon-button${hotkeyError ? ' has-warning' : ''}`}
          title={hotkeyError ? `${t('panel.hideAll')} — ${hotkeyError}` : t('panel.hideAll')}
          aria-label={t('panel.hideAll')}
          onClick={onHideAll}
        >
          <EyeIcon />
        </button>
        <button
          type="button"
          className="panel-icon-button"
          title={t('panel.settings')}
          aria-label={t('panel.settings')}
          onClick={onSettings}
        >
          <GearIcon />
        </button>
      </footer>
    </>
  )
}
