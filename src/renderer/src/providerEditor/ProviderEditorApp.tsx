import { useTranslation } from 'react-i18next'
import { Field, SwitchField } from '../profileEditor/fields'
import { normalizeProviderId } from '@shared/schema/provider'
import type { McpAttach, ModelDiscovery, SystemPromptDelivery } from '@shared/schema/provider'
import { versionDrift, type EffortStyleChoice, type ProviderDraft } from './model'
import { useProviderEditor } from './useProviderEditor'
import '../profileEditor/profileEditor.css'
import './providerEditor.css'

/**
 * The provider editor window — the recipe for starting one CLI.
 *
 * Seven bands, in the order a launch actually happens: who it is, how it is
 * started, how deep it thinks, how it logs in, how it learns who it is, how it
 * reaches Vertragus, and where its model list comes from. Every field is one
 * property of `providerConfigSchema`; nothing here is interpreted, which is why
 * a new CLI needs no Vertragus release.
 *
 * The presets are ordinary records of the same schema, so opening one edits it
 * — with a notice and a one-click way back, because "I changed Claude and now
 * nothing starts" must never be a dead end.
 */
export function ProviderEditorApp({ providerId }: { providerId?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const editor = useProviderEditor(providerId)
  const { draft } = editor

  if (editor.fatal) {
    return (
      <div className="pe glass">
        <p className="pe-fatal">{editor.fatal}</p>
      </div>
    )
  }
  if (!draft) {
    return (
      <div className="pe glass">
        <p className="pe-fatal">{t('common.loading')}</p>
      </div>
    )
  }

  const set = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]): void =>
    editor.update((current) => ({ ...current, [key]: value }))

  const text = (
    key: keyof ProviderDraft,
    options: { mono?: boolean; placeholder?: string } = {}
  ): React.JSX.Element => (
    <input
      className={options.mono === false ? 'pe-input' : 'pe-input pe-mono'}
      value={String(draft[key] ?? '')}
      spellCheck={false}
      {...(options.placeholder ? { placeholder: options.placeholder } : {})}
      onChange={(event) => set(key, event.target.value as ProviderDraft[typeof key])}
    />
  )

  const lines = (key: keyof ProviderDraft, rows = 3): React.JSX.Element => (
    <textarea
      className="pe-input pe-mono pe-textarea pv-lines"
      value={String(draft[key] ?? '')}
      rows={rows}
      spellCheck={false}
      onChange={(event) => set(key, event.target.value as ProviderDraft[typeof key])}
    />
  )

  return (
    <div className="pe glass">
      <header className="pe-head">
        <h1 className="pe-title">{editor.isNew ? t('providerEditor.titleNew') : t('providerEditor.title')}</h1>
        <span className="pe-profile-name">{draft.label}</span>
      </header>

      <div className="pe-body">
        {editor.isPreset ? (
          <div className="pv-preset">
            <span className="pv-preset-text">{t('providerEditor.presetNotice')}</span>
            <button
              type="button"
              className="pe-ghost pv-preset-reset"
              onClick={editor.removeOrReset}
            >
              {t('providerEditor.reset')}
            </button>
          </div>
        ) : null}

        {editor.health && !editor.health.available ? (
          <p className="pv-health is-bad">
            {editor.health.error ?? editor.health.detail ?? t('providerEditor.errors.command')}
          </p>
        ) : null}

        {(() => {
          // A hint, never an error: the launch flags were verified against one
          // CLI version, the health probe reports another. Nothing is blocked.
          const drift = versionDrift(draft.presetId, editor.health?.version)
          return drift ? (
            <p className="pe-hint pv-drift">
              {t('providerEditor.verifiedDrift', {
                verified: drift.verified,
                installed: drift.installed
              })}{' '}
              {t('providerEditor.verifiedOn', { date: drift.verifiedAt })}
            </p>
          ) : null
        })()}

        {/* --- identity --- */}
        <section className="pv-section">
          <h2 className="pe-section-label">{t('providerEditor.identity')}</h2>
          <div className="pv-grid">
            <Field label={t('providerEditor.label')} error={editor.errors.label}>
              <input
                className="pe-input"
                value={draft.label}
                placeholder={t('providerEditor.labelPlaceholder')}
                onChange={(event) => {
                  const label = event.target.value
                  // A new provider's id follows its name until the id is
                  // touched by hand; an existing one never moves — profiles
                  // reference it.
                  editor.update((current) => ({
                    ...current,
                    label,
                    ...(editor.isNew && current.id === normalizeProviderId(current.label)
                      ? { id: normalizeProviderId(label) }
                      : {})
                  }))
                }}
              />
            </Field>
            <Field
              label={t('providerEditor.id')}
              error={editor.errors.id}
              hint={editor.isNew ? t('providerEditor.idHint') : undefined}
            >
              <input
                className="pe-input pe-mono"
                value={draft.id}
                spellCheck={false}
                disabled={!editor.isNew}
                placeholder={t('providerEditor.idPlaceholder')}
                onChange={(event) => set('id', event.target.value)}
              />
            </Field>
            <Field
              label={t('providerEditor.command')}
              error={editor.errors.command}
              hint={t('providerEditor.commandHint')}
            >
              {text('command', { placeholder: t('providerEditor.commandPlaceholder') })}
            </Field>
            <div>
              <SwitchField
                label={t('providerEditor.enabled')}
                hint={t('providerEditor.enabledHint')}
                checked={draft.enabled}
                onChange={(enabled) => set('enabled', enabled)}
              />
            </div>
          </div>
        </section>

        {/* --- launch --- */}
        <section className="pv-section">
          <h2 className="pe-section-label">{t('providerEditor.launch')}</h2>
          <div className="pv-grid">
            <Field label={t('providerEditor.args')} error={editor.errors.args} hint={t('providerEditor.argsHint')}>
              {lines('args')}
            </Field>
            <Field
              label={t('providerEditor.yoloArgs')}
              error={editor.errors.yoloArgs}
              hint={t('providerEditor.yoloArgsHint')}
            >
              {lines('yoloArgs')}
            </Field>
            <Field
              label={t('providerEditor.modelArg')}
              error={editor.errors.modelArg}
              hint={t('providerEditor.modelArgHint')}
            >
              {text('modelArg', { placeholder: '--model' })}
            </Field>
            <Field
              label={t('providerEditor.versionArgs')}
              error={editor.errors.versionArgs}
              hint={t('providerEditor.versionArgsHint')}
            >
              {lines('versionArgs', 2)}
            </Field>
          </div>
        </section>

        {/* --- effort --- */}
        <section className="pv-section">
          <h2 className="pe-section-label">{t('providerEditor.effort')}</h2>
          <div className="pv-grid">
            <Field label={t('providerEditor.effortStyle')} error={editor.errors.effortStyle}>
              <select
                className="pe-input"
                value={draft.effortStyle}
                onChange={(event) => set('effortStyle', event.target.value as EffortStyleChoice)}
              >
                <option value="">{t('providerEditor.effortNone')}</option>
                <option value="flag">{t('providerEditor.effortFlagStyle')}</option>
                <option value="template">{t('providerEditor.effortTemplateStyle')}</option>
              </select>
            </Field>
            {draft.effortStyle === '' ? null : (
              <Field label={t('providerEditor.effortFlag')} error={editor.errors.effortFlag}>
                {text('effortFlag', { placeholder: '--effort' })}
              </Field>
            )}
            {draft.effortStyle === 'template' ? (
              <Field
                label={t('providerEditor.effortTemplate')}
                error={editor.errors.effortTemplate}
                hint={t('providerEditor.effortTemplateHint')}
              >
                {text('effortTemplate', { placeholder: 'model_reasoning_effort="{effort}"' })}
              </Field>
            ) : null}
          </div>
        </section>

        {/* --- auth --- */}
        <section className="pv-section">
          <h2 className="pe-section-label">{t('providerEditor.auth')}</h2>
          <div className="pv-grid">
            <Field
              label={t('providerEditor.authLoginArgs')}
              error={editor.errors.authLoginArgs}
              hint={t('providerEditor.authLoginArgsHint')}
            >
              {lines('authLoginArgs', 2)}
            </Field>
            <Field
              label={t('providerEditor.authStatusArgs')}
              error={editor.errors.authStatusArgs}
              hint={t('providerEditor.authStatusArgsHint')}
            >
              {lines('authStatusArgs', 2)}
            </Field>
          </div>
        </section>

        {/* --- system prompt --- */}
        <section className="pv-section">
          <h2 className="pe-section-label">{t('providerEditor.systemPrompt')}</h2>
          <div className="pv-grid">
            <Field label={t('providerEditor.promptKind')}>
              <select
                className="pe-input"
                value={draft.promptKind}
                onChange={(event) =>
                  set('promptKind', event.target.value as SystemPromptDelivery['kind'])
                }
              >
                <option value="arg">{t('providerEditor.promptKindArg')}</option>
                <option value="agent-file">{t('providerEditor.promptKindAgentFile')}</option>
                <option value="codex-config">{t('providerEditor.promptKindCodexConfig')}</option>
                <option value="pty">{t('providerEditor.promptKindPty')}</option>
              </select>
            </Field>
            {draft.promptKind === 'arg' || draft.promptKind === 'agent-file' ? (
              <Field
                label={t('providerEditor.promptFlag')}
                error={editor.errors.promptFlag}
                hint={
                  draft.promptKind === 'agent-file' ? t('providerEditor.promptAgentFileHint') : undefined
                }
              >
                {text('promptFlag', {
                  placeholder:
                    draft.promptKind === 'agent-file' ? '--agent-file' : '--append-system-prompt'
                })}
              </Field>
            ) : (
              <p className="pe-hint pv-wide">
                {draft.promptKind === 'pty' ? t('providerEditor.promptPtyHint') : t('providerEditor.promptCodexHint')}
              </p>
            )}
          </div>
        </section>

        {/* --- mcp --- */}
        <section className="pv-section">
          <h2 className="pe-section-label">{t('providerEditor.mcp')}</h2>
          <div className="pv-grid">
            <Field label={t('providerEditor.mcpKind')}>
              <select
                className="pe-input"
                value={draft.mcpKind}
                onChange={(event) => set('mcpKind', event.target.value as McpAttach['kind'])}
              >
                <option value="claude-json">{t('providerEditor.mcpKindClaudeJson')}</option>
                <option value="codex-overrides">{t('providerEditor.mcpKindCodexOverrides')}</option>
                <option value="kimi-project">{t('providerEditor.mcpKindKimiProject')}</option>
                <option value="cursor-project">{t('providerEditor.mcpKindCursorProject')}</option>
                <option value="grok-project">{t('providerEditor.mcpKindGrokProject')}</option>
                <option value="none">{t('providerEditor.mcpKindNone')}</option>
              </select>
            </Field>
            {draft.mcpKind === 'claude-json' ? (
              <>
                <Field label={t('providerEditor.mcpConfigArg')} error={editor.errors.mcpConfigArg}>
                  {text('mcpConfigArg', { placeholder: '--mcp-config' })}
                </Field>
                <Field
                  label={t('providerEditor.mcpStrictArg')}
                  error={editor.errors.mcpStrictArg}
                  hint={t('providerEditor.mcpStrictArgHint')}
                >
                  {text('mcpStrictArg', { placeholder: '--strict-mcp-config' })}
                </Field>
                <Field
                  label={t('providerEditor.mcpAllowedToolsArg')}
                  error={editor.errors.mcpAllowedToolsArg}
                  hint={t('providerEditor.mcpAllowedToolsArgHint')}
                >
                  {text('mcpAllowedToolsArg', { placeholder: '--allowedTools' })}
                </Field>
              </>
            ) : (
              <p className="pe-hint pv-wide">
                {draft.mcpKind === 'codex-overrides'
                  ? t('providerEditor.mcpCodexHint')
                  : draft.mcpKind === 'kimi-project'
                    ? t('providerEditor.mcpKimiHint')
                    : draft.mcpKind === 'cursor-project'
                      ? t('providerEditor.mcpCursorHint')
                      : draft.mcpKind === 'grok-project'
                        ? t('providerEditor.mcpGrokHint')
                        : t('providerEditor.mcpNoneHint')}
              </p>
            )}
          </div>
        </section>

        {/* --- model discovery --- */}
        <section className="pv-section">
          <h2 className="pe-section-label">{t('providerEditor.discovery')}</h2>
          <div className="pv-grid">
            <Field label={t('providerEditor.discoveryKind')}>
              <select
                className="pe-input"
                value={draft.discoveryKind}
                onChange={(event) =>
                  set('discoveryKind', event.target.value as ModelDiscovery['kind'])
                }
              >
                <option value="none">{t('providerEditor.discoveryNone')}</option>
                <option value="cli">{t('providerEditor.discoveryCli')}</option>
                <option value="file">{t('providerEditor.discoveryFile')}</option>
                <option value="http">{t('providerEditor.discoveryHttp')}</option>
              </select>
            </Field>

            {draft.discoveryKind === 'cli' ? (
              <Field
                label={t('providerEditor.discoveryArgs')}
                error={editor.errors.discoveryArgs}
                hint={t('providerEditor.discoveryArgsHint')}
              >
                {lines('discoveryArgs', 2)}
              </Field>
            ) : null}

            {draft.discoveryKind === 'file' ? (
              <Field
                label={t('providerEditor.discoveryPath')}
                error={editor.errors.discoveryPath}
                hint={t('providerEditor.discoveryPathHint')}
              >
                {text('discoveryPath', { placeholder: '~/.codex/models_cache.json' })}
              </Field>
            ) : null}

            {draft.discoveryKind === 'http' ? (
              <Field label={t('providerEditor.discoveryUrl')} error={editor.errors.discoveryUrl}>
                {text('discoveryUrl', { placeholder: 'http://127.0.0.1:11434/api/tags' })}
              </Field>
            ) : null}

            {draft.discoveryKind === 'cli' || draft.discoveryKind === 'file' ? (
              <Field label={t('providerEditor.discoveryParse')} error={editor.errors.discoveryParse}>
                <select
                  className="pe-input"
                  value={draft.discoveryParse}
                  onChange={(event) =>
                    set('discoveryParse', event.target.value as ProviderDraft['discoveryParse'])
                  }
                >
                  {draft.discoveryKind === 'cli' ? (
                    <option value="lines">{t('providerEditor.discoveryParseLines')}</option>
                  ) : null}
                  <option value="json">{t('providerEditor.discoveryParseJson')}</option>
                  {draft.discoveryKind === 'file' ? (
                    <option value="toml-keys">{t('providerEditor.discoveryParseTomlKeys')}</option>
                  ) : null}
                </select>
              </Field>
            ) : null}

            {draft.discoveryKind !== 'none' ? (
              <Field
                label={t('providerEditor.discoveryJsonPath')}
                error={editor.errors.discoveryJsonPath}
                hint={t('providerEditor.discoveryJsonPathHint')}
              >
                {text('discoveryJsonPath', { placeholder: 'models[].name' })}
              </Field>
            ) : null}

            <Field
              label={t('providerEditor.seedModels')}
              error={editor.errors.seedModels}
              hint={t('providerEditor.seedModelsHint')}
            >
              {lines('seedModels', 2)}
            </Field>
          </div>
        </section>

        {editor.errors.form ? <p className="pe-error pe-error-form">{editor.errors.form}</p> : null}
      </div>

      <footer className="pe-foot">
        {editor.isNew || editor.isPreset ? null : (
          <button type="button" className="pe-danger" onClick={editor.removeOrReset}>
            {t('providerEditor.deleteProvider')}
          </button>
        )}
        <span className="pe-foot-spacer" />
        <button type="button" className="pe-ghost" onClick={editor.cancel}>
          {t('common.cancel')}
        </button>
        <button type="button" className="pe-primary" onClick={editor.save} disabled={editor.saving}>
          {editor.saving ? t('common.saving') : t('common.save')}
        </button>
      </footer>
    </div>
  )
}
