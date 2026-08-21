import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  APPEARANCE_LIMITS,
  APPEARANCE_SLIDERS,
  type Appearance,
  type AppearanceSlider
} from '@shared/appearance'
import type { PanelSettings } from '../../../preload'
import { LOCALES, translator } from '../i18n'
import { useSettings, type SettingsState } from './useSettings'
import './settings.css'

/** Slider steps in percent — one per pixel of a 480px window is pointless. */
const APPEARANCE_STEP = 0.01

function percent(value: number): string {
  return `${Math.round(value * 100)} %`
}

/**
 * One appearance slider.
 *
 * The label carries the current value because a range input has no readout of
 * its own, and "how transparent is this exactly" is the question the whole
 * section exists to answer. Disabled — not hidden — while transparency is off:
 * a control that vanishes takes its stored value with it, as far as the user
 * can tell.
 */
function AppearanceSliderRow({
  appearance,
  field,
  disabled,
  onPatch
}: {
  appearance: Appearance
  field: AppearanceSlider
  disabled: boolean
  onPatch: SettingsState['patchAppearance']
}): React.JSX.Element {
  const { t } = useTranslation()
  const limits = APPEARANCE_LIMITS[field]
  return (
    <div className={disabled ? 'st-slider is-disabled' : 'st-slider'}>
      <label className="st-slider-head">
        <span className="st-slider-label">{t(`settings.glassSlider.${field}`)}</span>
        <span className="st-slider-value">{percent(appearance[field])}</span>
      </label>
      <input
        type="range"
        className="st-range"
        min={limits.min}
        max={limits.max}
        step={APPEARANCE_STEP}
        value={appearance[field]}
        disabled={disabled}
        aria-label={t(`settings.glassSlider.${field}`)}
        onChange={(event) => onPatch({ [field]: Number(event.target.value) })}
      />
      <span className="st-hint">{t(`settings.glassSlider.${field}Hint`)}</span>
    </div>
  )
}

/**
 * Wake-phrase and voice-id drafts. Keyed by the stored pair so a settings
 * update remounts with fresh initial state instead of syncing in an effect.
 */
function VoiceDraftFields({
  settings,
  set
}: {
  settings: PanelSettings
  set: SettingsState['set']
}): React.JSX.Element {
  const { t } = useTranslation()
  const [wake, setWake] = useState(settings.voiceWakePhrase)
  const [voiceId, setVoiceId] = useState(settings.voiceVoiceId)

  return (
    <>
      <div className="st-field">
        <span className="st-label">{t('settings.voiceWakePhrase')}</span>
        <input
          className="st-input"
          value={wake}
          maxLength={80}
          onChange={(event) => setWake(event.target.value)}
          onBlur={() => {
            const trimmed = wake.trim()
            if (trimmed && trimmed !== settings.voiceWakePhrase) {
              set('voice', { wakePhrase: trimmed })
            } else {
              setWake(settings.voiceWakePhrase)
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          }}
        />
        <span className="st-hint">{t('settings.voiceWakePhraseHint')}</span>
      </div>
      <div className="st-field">
        <span className="st-label">{t('settings.voiceVoiceId')}</span>
        <input
          className="st-input st-mono"
          value={voiceId}
          maxLength={40}
          onChange={(event) => setVoiceId(event.target.value)}
          onBlur={() => {
            const trimmed = voiceId.trim()
            if (trimmed && trimmed !== settings.voiceVoiceId) {
              set('voice', { voiceId: trimmed })
            } else {
              setVoiceId(settings.voiceVoiceId)
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          }}
        />
        <span className="st-hint">{t('settings.voiceVoiceIdHint')}</span>
      </div>
    </>
  )
}

function VoiceSection({
  settings,
  set
}: {
  settings: PanelSettings
  set: SettingsState['set']
}): React.JSX.Element {
  const { t } = useTranslation()
  const [apiKey, setApiKey] = useState('')

  return (
    <section className="st-glass-section">
      <h2 className="st-section-label">{t('settings.voice')}</h2>
      <label className="st-switch">
        <input
          type="checkbox"
          className="st-switch-input"
          checked={settings.voiceEnabled}
          onChange={(event) => set('voice', { enabled: event.target.checked })}
        />
        <span className="st-switch-text">
          <span className="st-switch-label">{t('settings.voiceEnabled')}</span>
          <span className="st-hint">{t('settings.voiceEnabledHint')}</span>
        </span>
      </label>
      <VoiceDraftFields
        key={`${settings.voiceWakePhrase}\0${settings.voiceVoiceId}`}
        settings={settings}
        set={set}
      />
      <div className="st-field">
        <span className="st-label">{t('settings.voiceApiKey')}</span>
        <input
          type="password"
          className="st-input st-mono"
          value={apiKey}
          maxLength={200}
          autoComplete="off"
          placeholder={
            settings.voiceApiKeySet
              ? t('settings.voiceApiKeySet')
              : t('settings.voiceApiKeyPlaceholder')
          }
          onChange={(event) => setApiKey(event.target.value)}
          onBlur={() => {
            if (apiKey.length > 0) {
              set('voice', { apiKey })
              setApiKey('')
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          }}
        />
        <span className="st-hint">{t('settings.voiceApiKeyHint')}</span>
      </div>
    </section>
  )
}

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
  const { t } = useTranslation()
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
        <p className="st-fatal">{t('common.loading')}</p>
      </div>
    )
  }

  const update = view.update
  // The status union is closed (see `UpdateStatus`), so every member has a key;
  // an unknown one still shows its raw name rather than an empty line.
  const statusKey = `settings.updateStatus.${update?.status}`
  const statusText = update ? t([statusKey, update.status]) : t('common.loading')
  // The updater's own `message` is authored in the main process and therefore
  // German. For `disabled` it says exactly what the status line already says,
  // so it is dropped — comparing against BOTH languages, not just the current
  // one: in English the two strings differ and the German sentence would be
  // printed underneath the English one.
  const messageAddsSomething =
    update?.message !== undefined &&
    !LOCALES.some((locale) => translator(locale)(statusKey) === update.message)

  return (
    <div className="st glass">
      <header className="st-head">
        <h1 className="st-title">{t('settings.title')}</h1>
        <span className="st-subtitle">{t('settings.subtitle')}</span>
      </header>

      <div className="st-body">
        <section className="st-field">
          <span className="st-label">{t('settings.hotkey')}</span>
          <div className="st-row">
            <input
              className="st-input st-mono"
              value={view.hotkeyDraft}
              spellCheck={false}
              placeholder={t('settings.hotkeyPlaceholder')}
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
              {t('settings.hotkeySave')}
            </button>
          </div>
          {view.hotkeyError ? (
            <span className="st-error">{view.hotkeyError}</span>
          ) : (
            <span className="st-hint">{t('settings.hotkeyHint')}</span>
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
              <span className="st-switch-label">{t('settings.autostart')}</span>
              <span className={settings.autostartSupported ? 'st-hint' : 'st-hint is-warn'}>
                {settings.autostartSupported
                  ? t('settings.autostartHint')
                  : t('settings.autostartUnsupported')}
              </span>
            </span>
          </label>
        </section>

        <section className="st-field">
          <span className="st-label">{t('settings.updateChannel')}</span>
          <select
            className="st-input"
            value={settings.updateChannel}
            onChange={(event) => view.set('updateChannel', event.target.value)}
          >
            <option value="main">{t('settings.updateChannelMain')}</option>
            <option value="stable">{t('settings.updateChannelStable')}</option>
          </select>
          <span className="st-hint">{t('settings.updateChannelHint')}</span>
        </section>

        <div className="st-pair">
          <section className="st-field">
            <span className="st-label">{t('settings.theme')}</span>
            <select
              className="st-input"
              value={settings.theme}
              onChange={(event) => view.set('theme', event.target.value)}
            >
              <option value="dark">{t('settings.themeDark')}</option>
              <option value="light">{t('settings.themeLight')}</option>
            </select>
            <span className="st-hint">{t('settings.themeHint')}</span>
          </section>

          <section className="st-field">
            <span className="st-label">{t('settings.locale')}</span>
            <select
              className="st-input"
              value={settings.locale}
              onChange={(event) => view.set('locale', event.target.value)}
            >
              <option value="de">{t('settings.localeDe')}</option>
              <option value="en">{t('settings.localeEn')}</option>
            </select>
            <span className="st-hint">{t('settings.localeHint')}</span>
          </section>
        </div>

        <VoiceSection settings={settings} set={view.set} />

        <section className="st-glass-section">
          <h2 className="st-section-label">{t('settings.glass')}</h2>
          <label className="st-switch">
            <input
              type="checkbox"
              className="st-switch-input"
              checked={settings.appearance.translucent}
              onChange={(event) => view.patchAppearance({ translucent: event.target.checked })}
            />
            <span className="st-switch-text">
              <span className="st-switch-label">{t('settings.translucent')}</span>
              <span className="st-hint">
                {settings.appearance.translucent
                  ? t('settings.translucentHint')
                  : t('settings.translucentOffHint')}
              </span>
            </span>
          </label>
          {APPEARANCE_SLIDERS.map((field) => (
            <AppearanceSliderRow
              key={field}
              field={field}
              appearance={settings.appearance}
              disabled={!settings.appearance.translucent}
              onPatch={view.patchAppearance}
            />
          ))}
          <span className="st-hint">{t('settings.glassLadderHint')}</span>
        </section>

        <section className="st-updates">
          <h2 className="st-section-label">{t('settings.updates')}</h2>
          <p className="st-update-line">
            <span className={`st-dot is-${update?.status ?? 'idle'}`} />
            <span className="st-update-status">{statusText}</span>
            {update?.status === 'downloading' && update.progress !== undefined ? (
              <span className="st-update-progress">
                {t('settings.updateProgress', { percent: Math.round(update.progress) })}
              </span>
            ) : null}
          </p>
          {messageAddsSomething ? <p className="st-hint">{update?.message}</p> : null}
          {update?.availableVersion ? (
            <p className="st-hint">{t('settings.updateAvailable', { version: update.availableVersion })}</p>
          ) : null}
          <div className="st-row">
            <span className="st-version">
              {t('settings.updateVersion', { version: update?.currentVersion ?? '—' })}
            </span>
            <span className="st-spacer" />
            <button
              type="button"
              className="st-secondary"
              disabled={!update || update.status === 'disabled' || update.status === 'checking'}
              onClick={view.checkForUpdates}
            >
              {t('settings.updateCheck')}
            </button>
            {update?.status === 'downloaded' ? (
              <button type="button" className="st-primary" onClick={view.installUpdate}>
                {t('settings.updateInstall')}
              </button>
            ) : null}
          </div>
        </section>

        {view.error ? <p className="st-error st-error-form">{view.error}</p> : null}
      </div>

      <footer className="st-foot">
        <span className="st-spacer" />
        <button type="button" className="st-ghost" onClick={view.close}>
          {t('settings.close')}
        </button>
      </footer>
    </div>
  )
}
