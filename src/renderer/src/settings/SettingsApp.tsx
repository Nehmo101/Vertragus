import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import {
  APPEARANCE_LIMITS,
  APPEARANCE_SLIDERS,
  type Appearance,
  type AppearanceSlider
} from '@shared/appearance'
import type { PanelMcpServer, PanelSettings } from '../../../preload'
import { RemoteSection } from './RemoteSection'
import { BrowserExtensionSection } from './BrowserExtensionSection'
import { normalizeMcpServerId } from '@shared/schema/mcpServer'
import {
  draftFromServer,
  emptyMcpDraft,
  MAX_EXTRA_MCP_SERVERS,
  parseEnvLines,
  parseHeaderLines,
  parseArgLines,
  toMcpServersPatch,
  validateMcpDraft,
  type McpDraftErrors,
  type McpServerDraft
} from './model'
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

type MediaKind = 'audioinput' | 'audiooutput'

interface DeviceSnapshot {
  inputs: { id: string; label: string }[]
  outputs: { id: string; label: string }[]
}

const EMPTY_DEVICES: DeviceSnapshot = { inputs: [], outputs: [] }
let deviceSnapshot: DeviceSnapshot = EMPTY_DEVICES
const deviceListeners = new Set<() => void>()

function emitDevices(): void {
  for (const listener of deviceListeners) listener()
}

function mapDevices(list: MediaDeviceInfo[]): DeviceSnapshot {
  const labelOf = (device: MediaDeviceInfo, fallback: string): string =>
    device.label.trim() || fallback
  return {
    inputs: list
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        id: device.deviceId,
        label: labelOf(device, `mic-${index + 1}`)
      })),
    outputs: list
      .filter((device) => device.kind === 'audiooutput')
      .map((device, index) => ({
        id: device.deviceId,
        label: labelOf(device, `out-${index + 1}`)
      }))
  }
}

async function refreshDevices(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) return
  let list = await navigator.mediaDevices.enumerateDevices()
  const unlabeled = list.some(
    (device) =>
      (device.kind === 'audioinput' || device.kind === 'audiooutput') && !device.label.trim()
  )
  if (unlabeled) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
      list = await navigator.mediaDevices.enumerateDevices()
    } catch {
      /* labels stay empty — ids still persist */
    }
  }
  deviceSnapshot = mapDevices(list)
  emitDevices()
}

function subscribeDevices(listener: () => void): () => void {
  deviceListeners.add(listener)
  void refreshDevices()
  const onChange = (): void => {
    void refreshDevices()
  }
  navigator.mediaDevices?.addEventListener('devicechange', onChange)
  return () => {
    deviceListeners.delete(listener)
    navigator.mediaDevices?.removeEventListener('devicechange', onChange)
  }
}

function useMediaDeviceOptions(): DeviceSnapshot {
  return useSyncExternalStore(subscribeDevices, () => deviceSnapshot, () => EMPTY_DEVICES)
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
            if (trimmed !== settings.voiceVoiceId) {
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

function VoiceKeyField({
  label,
  hint,
  placeholder,
  setPlaceholder,
  alreadySet,
  onCommit
}: {
  label: string
  hint: string
  placeholder: string
  setPlaceholder: string
  alreadySet: boolean
  onCommit: (value: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  return (
    <div className="st-field">
      <span className="st-label">{label}</span>
      <input
        type="password"
        className="st-input st-mono"
        value={value}
        maxLength={200}
        autoComplete="off"
        placeholder={alreadySet ? setPlaceholder : placeholder}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (value.length > 0) {
            onCommit(value)
            setValue('')
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        }}
      />
      <span className="st-hint">{hint}</span>
    </div>
  )
}

function VoiceDeviceSelect({
  kind,
  value,
  options,
  onChange
}: {
  kind: MediaKind
  value: string
  options: { id: string; label: string }[]
  onChange: (deviceId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const present = value === '' || options.some((option) => option.id === value)
  return (
    <div className="st-field">
      <span className="st-label">
        {kind === 'audioinput' ? t('settings.voiceInputDevice') : t('settings.voiceOutputDevice')}
      </span>
      <select
        className="st-input"
        value={present ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t('settings.voiceDeviceDefault')}</option>
        {options.map((option) => (
          <option key={option.id || option.label} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="st-hint">
        {present
          ? kind === 'audioinput'
            ? t('settings.voiceInputDeviceHint')
            : t('settings.voiceOutputDeviceHint')
          : t('settings.voiceDeviceMissing')}
      </span>
    </div>
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
  const devices = useMediaDeviceOptions()

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
      <div className="st-field">
        <span className="st-label">{t('settings.voiceProvider')}</span>
        <select
          className="st-input"
          value={settings.voiceProvider}
          onChange={(event) => set('voice', { provider: event.target.value })}
        >
          <option value="xai">{t('settings.voiceProviderXai')}</option>
          <option value="openai">{t('settings.voiceProviderOpenai')}</option>
        </select>
        <span className="st-hint">{t('settings.voiceProviderHint')}</span>
      </div>
      <VoiceDraftFields
        key={`${settings.voiceWakePhrase}\0${settings.voiceVoiceId}`}
        settings={settings}
        set={set}
      />
      <VoiceKeyField
        label={t('settings.voiceApiKey')}
        hint={t('settings.voiceApiKeyHint')}
        placeholder={t('settings.voiceApiKeyPlaceholder')}
        setPlaceholder={t('settings.voiceApiKeySet')}
        alreadySet={settings.voiceApiKeySet}
        onCommit={(apiKey) => set('voice', { apiKey })}
      />
      <VoiceKeyField
        label={t('settings.voiceOpenaiApiKey')}
        hint={t('settings.voiceOpenaiApiKeyHint')}
        placeholder={t('settings.voiceOpenaiApiKeyPlaceholder')}
        setPlaceholder={t('settings.voiceOpenaiApiKeySet')}
        alreadySet={settings.voiceOpenaiApiKeySet}
        onCommit={(openaiApiKey) => set('voice', { openaiApiKey })}
      />
      <VoiceDeviceSelect
        kind="audioinput"
        value={settings.voiceInputDeviceId}
        options={devices.inputs}
        onChange={(inputDeviceId) => set('voice', { inputDeviceId })}
      />
      <VoiceDeviceSelect
        kind="audiooutput"
        value={settings.voiceOutputDeviceId}
        options={devices.outputs}
        onChange={(outputDeviceId) => set('voice', { outputDeviceId })}
      />
    </section>
  )
}

/**
 * The settings window — the sheet behind the panel's gear.
 *
 * Deliberately small. App-wide settings rather than profile ones, with
 * Tailscale remote access first so enabling a phone does not mean scrolling
 * past glass sliders. Extra MCP servers, glass and the self-updater sit
 * further down. Everything a profile owns (providers, models, slots, zones)
 * lives in the profile editor, and putting either half into the other window
 * is how a settings dialog turns into a second, worse copy of the app.
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
  // The updater's `message` comes from the main process via `mainMessages`,
  // in the stored locale. For `disabled` it says by construction exactly what
  // the status line already says (`settings.updateStatus.disabled`), so only
  // the other states print it underneath.
  const messageAddsSomething = update?.message !== undefined && update?.status !== 'disabled'

  return (
    <div className="st glass">
      <header className="st-head">
        <h1 className="st-title">{t('settings.title')}</h1>
        <span className="st-subtitle">{t('settings.subtitle')}</span>
      </header>

      <div className="st-body">
        <RemoteSection />
        <BrowserExtensionSection />

        <section className="st-field">
          <span className="st-label">{t('settings.agentPolicy')}</span>
          <select
            className="st-input"
            value={settings.agentPolicy}
            onChange={(event) => view.set('agentPolicy', event.target.value)}
          >
            <option value="yolo">{t('settings.agentPolicyYolo')}</option>
            <option value="ask-user">{t('settings.agentPolicyAskUser')}</option>
            <option value="ask-orchestrator">{t('settings.agentPolicyAskOrchestrator')}</option>
          </select>
          <span className="st-hint">{t('settings.agentPolicyHint')}</span>
        </section>

        <section className="st-field">
          <span className="st-label">{t('settings.cliSurface')}</span>
          <select
            className="st-input"
            value={settings.cliSurface}
            onChange={(event) => view.set('cliSurface', event.target.value)}
          >
            <option value="session">{t('settings.cliSurfaceSession')}</option>
            <option value="raw">{t('settings.cliSurfaceRaw')}</option>
          </select>
          <span className="st-hint">{t('settings.cliSurfaceHint')}</span>
        </section>

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
          <label className="st-switch">
            <input
              type="checkbox"
              className="st-switch-input"
              checked={settings.reflowNeighbors}
              onChange={(event) => view.set('reflowNeighbors', event.target.checked)}
            />
            <span className="st-switch-text">
              <span className="st-switch-label">{t('settings.reflowNeighbors')}</span>
              <span className="st-hint">{t('settings.reflowNeighborsHint')}</span>
            </span>
          </label>
        </section>

        <section className="st-field">
          <label className="st-switch">
            <input
              type="checkbox"
              className="st-switch-input"
              checked={settings.snapToZones}
              onChange={(event) => view.set('snapToZones', event.target.checked)}
            />
            <span className="st-switch-text">
              <span className="st-switch-label">{t('settings.snapToZones')}</span>
              <span className="st-hint">{t('settings.snapToZonesHint')}</span>
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

        <McpServersSection
          servers={settings.mcpServers}
          saving={view.saving}
          onWrite={(next, secretDrafts) =>
            view.set('mcpServers', toMcpServersPatch(next, secretDrafts))
          }
        />

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

function panelFromDraft(draft: McpServerDraft): PanelMcpServer {
  const id = normalizeMcpServerId(draft.id) || draft.id.trim()
  const env = parseEnvLines(draft.envText)
  const headers = parseHeaderLines(draft.headersText)
  if (draft.transport === 'http') {
    return {
      id,
      label: draft.label.trim(),
      enabled: draft.enabled,
      transport: 'http',
      url: draft.url.trim(),
      envKeys: [],
      headerKeys: Object.keys(headers),
      envSet: {},
      headersSet: {}
    }
  }
  return {
    id,
    label: draft.label.trim(),
    enabled: draft.enabled,
    transport: 'stdio',
    command: draft.command.trim(),
    args: parseArgLines(draft.argsText),
    envKeys: Object.keys(env),
    headerKeys: [],
    envSet: {},
    headersSet: {}
  }
}

function McpServersSection({
  servers,
  saving,
  onWrite
}: {
  servers: PanelMcpServer[]
  saving: boolean
  onWrite: (
    next: PanelMcpServer[],
    secretDrafts?: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>
  ) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<McpServerDraft | null>(null)
  const [errors, setErrors] = useState<McpDraftErrors>({})

  const patch = (update: Partial<McpServerDraft>): void => {
    setDraft((current) => (current ? { ...current, ...update } : current))
    setErrors({})
  }

  const save = (): void => {
    if (!draft) return
    const result = validateMcpDraft(t, draft, servers)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    const panel = panelFromDraft(draft)
    const next = draft.editingId
      ? servers.map((server) => (server.id === draft.editingId ? panel : server))
      : [...servers, panel]
    const secrets =
      draft.transport === 'stdio'
        ? { env: parseEnvLines(draft.envText) }
        : { headers: parseHeaderLines(draft.headersText) }
    onWrite(next, { [panel.id]: secrets })
    setDraft(null)
    setErrors({})
  }

  return (
    <section className="st-mcp-section">
      <h2 className="st-section-label">{t('settings.mcp.title')}</h2>
      <span className="st-hint">{t('settings.mcp.hint')}</span>

      {servers.length === 0 && !draft ? (
        <span className="st-hint">{t('settings.mcp.empty')}</span>
      ) : (
        <ul className="st-mcp-list">
          {servers.map((server) => (
            <li key={server.id} className="st-mcp-row">
              <div className="st-mcp-row-main">
                <span className="st-mcp-row-label">{server.label}</span>
                <span className="st-mcp-row-id">{server.id}</span>
              </div>
              <span className="st-mcp-badge">
                {server.transport === 'stdio'
                  ? t('settings.mcp.transportStdio')
                  : t('settings.mcp.transportHttp')}
              </span>
              <label className="st-switch">
                <input
                  type="checkbox"
                  className="st-switch-input"
                  checked={server.enabled}
                  disabled={saving}
                  aria-label={t('settings.mcp.enabled')}
                  onChange={(event) =>
                    onWrite(
                      servers.map((entry) =>
                        entry.id === server.id ? { ...entry, enabled: event.target.checked } : entry
                      )
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="st-ghost"
                onClick={() => {
                  setDraft(draftFromServer(server))
                  setErrors({})
                }}
              >
                {t('settings.mcp.edit')}
              </button>
              <button
                type="button"
                className="st-ghost"
                onClick={() => {
                  if (!window.confirm(t('settings.mcp.deleteConfirm', { label: server.label }))) {
                    return
                  }
                  onWrite(servers.filter((entry) => entry.id !== server.id))
                  if (draft?.editingId === server.id) {
                    setDraft(null)
                    setErrors({})
                  }
                }}
              >
                {t('settings.mcp.delete')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {draft ? (
        <div className="st-mcp-form">
          <section className="st-field">
            <span className="st-label">{t('settings.mcp.label')}</span>
            <input
              className="st-input"
              value={draft.label}
              onChange={(event) => {
                const label = event.target.value
                const followId = !draft.editingId && draft.id === normalizeMcpServerId(draft.label)
                patch({ label, ...(followId ? { id: normalizeMcpServerId(label) } : {}) })
              }}
            />
            {errors.label ? <span className="st-error">{errors.label}</span> : null}
          </section>
          <section className="st-field">
            <span className="st-label">{t('settings.mcp.id')}</span>
            <input
              className="st-input st-mono"
              value={draft.id}
              spellCheck={false}
              onChange={(event) => patch({ id: event.target.value })}
            />
            <span className="st-hint">{t('settings.mcp.idHint')}</span>
            {errors.id ? <span className="st-error">{errors.id}</span> : null}
          </section>
          <section className="st-field">
            <label className="st-switch">
              <input
                type="checkbox"
                className="st-switch-input"
                checked={draft.enabled}
                onChange={(event) => patch({ enabled: event.target.checked })}
              />
              <span className="st-switch-text">
                <span className="st-switch-label">{t('settings.mcp.enabled')}</span>
              </span>
            </label>
          </section>
          <section className="st-field">
            <span className="st-label">{t('settings.mcp.transport')}</span>
            <select
              className="st-input"
              value={draft.transport}
              onChange={(event) =>
                patch({ transport: event.target.value === 'http' ? 'http' : 'stdio' })
              }
            >
              <option value="stdio">{t('settings.mcp.transportStdio')}</option>
              <option value="http">{t('settings.mcp.transportHttp')}</option>
            </select>
          </section>
          {draft.transport === 'stdio' ? (
            <>
              <section className="st-field">
                <span className="st-label">{t('settings.mcp.command')}</span>
                <input
                  className="st-input st-mono"
                  value={draft.command}
                  onChange={(event) => patch({ command: event.target.value })}
                />
                <span className="st-hint">{t('settings.mcp.commandHint')}</span>
                {errors.command ? <span className="st-error">{errors.command}</span> : null}
              </section>
              <section className="st-field">
                <span className="st-label">{t('settings.mcp.args')}</span>
                <textarea
                  className="st-textarea st-mono"
                  value={draft.argsText}
                  spellCheck={false}
                  onChange={(event) => patch({ argsText: event.target.value })}
                />
                <span className="st-hint">{t('settings.mcp.argsHint')}</span>
              </section>
              <section className="st-field">
                <span className="st-label">{t('settings.mcp.env')}</span>
                <textarea
                  className="st-textarea st-mono"
                  value={draft.envText}
                  spellCheck={false}
                  onChange={(event) => patch({ envText: event.target.value })}
                />
                <span className="st-hint">{t('settings.mcp.envHint')}</span>
              </section>
            </>
          ) : (
            <>
              <section className="st-field">
                <span className="st-label">{t('settings.mcp.url')}</span>
                <input
                  className="st-input st-mono"
                  value={draft.url}
                  spellCheck={false}
                  onChange={(event) => patch({ url: event.target.value })}
                />
                {errors.url ? <span className="st-error">{errors.url}</span> : null}
              </section>
              <section className="st-field">
                <span className="st-label">{t('settings.mcp.headers')}</span>
                <textarea
                  className="st-textarea st-mono"
                  value={draft.headersText}
                  spellCheck={false}
                  onChange={(event) => patch({ headersText: event.target.value })}
                />
                <span className="st-hint">{t('settings.mcp.headersHint')}</span>
              </section>
            </>
          )}
          <div className="st-mcp-actions">
            <button type="button" className="st-secondary" disabled={saving} onClick={save}>
              {t('settings.mcp.save')}
            </button>
            <button
              type="button"
              className="st-ghost"
              onClick={() => {
                setDraft(null)
                setErrors({})
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="st-mcp-actions">
          <button
            type="button"
            className="st-secondary"
            disabled={servers.length >= MAX_EXTRA_MCP_SERVERS}
            onClick={() => setDraft(emptyMcpDraft())}
          >
            {t('settings.mcp.add')}
          </button>
        </div>
      )}
    </section>
  )
}
