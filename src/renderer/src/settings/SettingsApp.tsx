import { SETTINGS_STRINGS } from './strings'
import { useSettings } from './useSettings'
import './settings.css'

/**
 * The settings window — the sheet behind the panel's gear.
 *
 * Deliberately small. Five settings that belong to the app rather than to a
 * profile, plus the state of the self-updater. Everything a profile owns
 * (providers, models, slots, zones) lives in the profile editor, and putting
 * either half into the other window is how a settings dialog turns into a
 * second, worse copy of the app.
 *
 * Two fields carry a warning instead of being disabled: autostart in a dev run
 * and the hotkey the OS refused. A greyed-out control with no explanation is
 * what the first test run reported as "broken".
 */
export function SettingsApp(): React.JSX.Element {
  const view = useSettings()
  const { settings } = view

  if (view.fatal) {
    return (
      <div className="st glass">
        <p className="st-fatal">{view.fatal}</p>
      </div>
    )
  }
  if (!settings) {
    return (
      <div className="st glass">
        <p className="st-fatal">{SETTINGS_STRINGS.loading}</p>
      </div>
    )
  }

  const update = view.update
  const statusText = update
    ? (SETTINGS_STRINGS.updateStatus[update.status] ?? update.status)
    : SETTINGS_STRINGS.loading

  return (
    <div className="st glass">
      <header className="st-head">
        <h1 className="st-title">{SETTINGS_STRINGS.title}</h1>
        <span className="st-subtitle">{SETTINGS_STRINGS.subtitle}</span>
      </header>

      <div className="st-body">
        <section className="st-field">
          <span className="st-label">{SETTINGS_STRINGS.hotkey}</span>
          <div className="st-row">
            <input
              className="st-input st-mono"
              value={view.hotkeyDraft}
              spellCheck={false}
              placeholder={SETTINGS_STRINGS.hotkeyPlaceholder}
              onChange={(event) => view.setHotkeyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') view.saveHotkey()
              }}
            />
            <button
              type="button"
              className="st-secondary"
              disabled={view.saving || view.hotkeyDraft === settings.hideAllHotkey}
              onClick={view.saveHotkey}
            >
              {SETTINGS_STRINGS.hotkeySave}
            </button>
          </div>
          {view.hotkeyError ? (
            <span className="st-error">{view.hotkeyError}</span>
          ) : (
            <span className="st-hint">{SETTINGS_STRINGS.hotkeyHint}</span>
          )}
        </section>

        <section className="st-field">
          <label className="st-switch">
            <input
              type="checkbox"
              className="st-switch-input"
              checked={settings.autostart}
              disabled={!settings.autostartSupported}
              onChange={(event) => view.set('autostart', event.target.checked)}
            />
            <span className="st-switch-text">
              <span className="st-switch-label">{SETTINGS_STRINGS.autostart}</span>
              <span className={settings.autostartSupported ? 'st-hint' : 'st-hint is-warn'}>
                {settings.autostartSupported
                  ? SETTINGS_STRINGS.autostartHint
                  : SETTINGS_STRINGS.autostartUnsupported}
              </span>
            </span>
          </label>
        </section>

        <section className="st-field">
          <span className="st-label">{SETTINGS_STRINGS.updateChannel}</span>
          <select
            className="st-input"
            value={settings.updateChannel}
            onChange={(event) => view.set('updateChannel', event.target.value)}
          >
            <option value="main">{SETTINGS_STRINGS.updateChannelMain}</option>
            <option value="stable">{SETTINGS_STRINGS.updateChannelStable}</option>
          </select>
          <span className="st-hint">{SETTINGS_STRINGS.updateChannelHint}</span>
        </section>

        <div className="st-pair">
          <section className="st-field">
            <span className="st-label">{SETTINGS_STRINGS.theme}</span>
            <select
              className="st-input"
              value={settings.theme}
              onChange={(event) => view.set('theme', event.target.value)}
            >
              <option value="dark">{SETTINGS_STRINGS.themeDark}</option>
              <option value="light">{SETTINGS_STRINGS.themeLight}</option>
            </select>
            <span className="st-hint">{SETTINGS_STRINGS.themeHint}</span>
          </section>

          <section className="st-field">
            <span className="st-label">{SETTINGS_STRINGS.locale}</span>
            <select
              className="st-input"
              value={settings.locale}
              onChange={(event) => view.set('locale', event.target.value)}
            >
              <option value="de">{SETTINGS_STRINGS.localeDe}</option>
              <option value="en">{SETTINGS_STRINGS.localeEn}</option>
            </select>
            <span className="st-hint">{SETTINGS_STRINGS.localeHint}</span>
          </section>
        </div>

        <section className="st-updates">
          <h2 className="st-section-label">{SETTINGS_STRINGS.updates}</h2>
          <p className="st-update-line">
            <span className={`st-dot is-${update?.status ?? 'idle'}`} />
            <span className="st-update-status">{statusText}</span>
            {update?.status === 'downloading' && update.progress !== undefined ? (
              <span className="st-update-progress">
                {SETTINGS_STRINGS.updateProgress(update.progress)}
              </span>
            ) : null}
          </p>
          {/* Only when it adds something: for `disabled` the message IS the
              status line, and printing both reads like a stutter. */}
          {update?.message && update.message !== statusText ? (
            <p className="st-hint">{update.message}</p>
          ) : null}
          {update?.availableVersion ? (
            <p className="st-hint">{SETTINGS_STRINGS.updateAvailable(update.availableVersion)}</p>
          ) : null}
          <div className="st-row">
            <span className="st-version">
              {SETTINGS_STRINGS.updateVersion(update?.currentVersion ?? '—')}
            </span>
            <span className="st-spacer" />
            <button
              type="button"
              className="st-secondary"
              disabled={!update || update.status === 'disabled' || update.status === 'checking'}
              onClick={view.checkForUpdates}
            >
              {SETTINGS_STRINGS.updateCheck}
            </button>
            {update?.status === 'downloaded' ? (
              <button type="button" className="st-primary" onClick={view.installUpdate}>
                {SETTINGS_STRINGS.updateInstall}
              </button>
            ) : null}
          </div>
        </section>

        {view.error ? <p className="st-error st-error-form">{view.error}</p> : null}
      </div>

      <footer className="st-foot">
        <span className="st-spacer" />
        <button type="button" className="st-ghost" onClick={view.close}>
          {SETTINGS_STRINGS.close}
        </button>
      </footer>
    </div>
  )
}
