import { Field, SwitchField } from '../profileEditor/fields'
import { normalizeProviderId } from '@shared/schema/provider'
import type { McpAttach, ModelDiscovery, SystemPromptDelivery } from '@shared/schema/provider'
import { type EffortStyleChoice, type ProviderDraft } from './model'
import { PROVIDER_STRINGS } from './strings'
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
  const editor = useProviderEditor(providerId)
  const { draft } = editor
  const strings = PROVIDER_STRINGS

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
        <p className="pe-fatal">{strings.loading}</p>
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
        <h1 className="pe-title">{editor.isNew ? strings.titleNew : strings.title}</h1>
        <span className="pe-profile-name">{draft.label}</span>
      </header>

      <div className="pe-body">
        {editor.isPreset ? (
          <div className="pv-preset">
            <span className="pv-preset-text">{strings.presetNotice}</span>
            <button
              type="button"
              className="pe-ghost pv-preset-reset"
              onClick={editor.removeOrReset}
            >
              {strings.reset}
            </button>
          </div>
        ) : null}

        {editor.health && !editor.health.available ? (
          <p className="pv-health is-bad">
            {editor.health.error ?? editor.health.detail ?? strings.errors.command}
          </p>
        ) : null}

        {/* --- identity --- */}
        <section className="pv-section">
          <h2 className="pe-section-label">{strings.identity}</h2>
          <div className="pv-grid">
            <Field label={strings.label} error={editor.errors.label}>
              <input
                className="pe-input"
                value={draft.label}
                placeholder={strings.labelPlaceholder}
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
              label={strings.id}
              error={editor.errors.id}
              hint={editor.isNew ? strings.idHint : undefined}
            >
              <input
                className="pe-input pe-mono"
                value={draft.id}
                spellCheck={false}
                disabled={!editor.isNew}
                placeholder={strings.idPlaceholder}
                onChange={(event) => set('id', event.target.value)}
              />
            </Field>
            <Field
              label={strings.command}
              error={editor.errors.command}
              hint={strings.commandHint}
            >
              {text('command', { placeholder: strings.commandPlaceholder })}
            </Field>
            <div>
              <SwitchField
                label={strings.enabled}
                hint={strings.enabledHint}
                checked={draft.enabled}
                onChange={(enabled) => set('enabled', enabled)}
              />
            </div>
          </div>
        </section>

        {/* --- launch --- */}
        <section className="pv-section">
          <h2 className="pe-section-label">{strings.launch}</h2>
          <div className="pv-grid">
            <Field label={strings.args} error={editor.errors.args} hint={strings.argsHint}>
              {lines('args')}
            </Field>
            <Field
              label={strings.yoloArgs}
              error={editor.errors.yoloArgs}
              hint={strings.yoloArgsHint}
            >
              {lines('yoloArgs')}
            </Field>
            <Field
              label={strings.modelArg}
              error={editor.errors.modelArg}
              hint={strings.modelArgHint}
            >
              {text('modelArg', { placeholder: '--model' })}
            </Field>
            <Field
              label={strings.versionArgs}
              error={editor.errors.versionArgs}
              hint={strings.versionArgsHint}
            >
              {lines('versionArgs', 2)}
            </Field>
          </div>
        </section>

        {/* --- effort --- */}
        <section className="pv-section">
          <h2 className="pe-section-label">{strings.effort}</h2>
          <div className="pv-grid">
            <Field label={strings.effortStyle} error={editor.errors.effortStyle}>
              <select
                className="pe-input"
                value={draft.effortStyle}
                onChange={(event) => set('effortStyle', event.target.value as EffortStyleChoice)}
              >
                <option value="">{strings.effortNone}</option>
                <option value="flag">{strings.effortFlagStyle}</option>
                <option value="template">{strings.effortTemplateStyle}</option>
              </select>
            </Field>
            {draft.effortStyle === '' ? null : (
              <Field label={strings.effortFlag} error={editor.errors.effortFlag}>
                {text('effortFlag', { placeholder: '--effort' })}
              </Field>
            )}
            {draft.effortStyle === 'template' ? (
              <Field
                label={strings.effortTemplate}
                error={editor.errors.effortTemplate}
                hint={strings.effortTemplateHint}
              >
                {text('effortTemplate', { placeholder: 'model_reasoning_effort="{effort}"' })}
              </Field>
            ) : null}
          </div>
        </section>

        {/* --- auth --- */}
        <section className="pv-section">
          <h2 className="pe-section-label">{strings.auth}</h2>
          <div className="pv-grid">
            <Field
              label={strings.authLoginArgs}
              error={editor.errors.authLoginArgs}
              hint={strings.authLoginArgsHint}
            >
              {lines('authLoginArgs', 2)}
            </Field>
            <Field
              label={strings.authStatusArgs}
              error={editor.errors.authStatusArgs}
              hint={strings.authStatusArgsHint}
            >
              {lines('authStatusArgs', 2)}
            </Field>
          </div>
        </section>

        {/* --- system prompt --- */}
        <section className="pv-section">
          <h2 className="pe-section-label">{strings.systemPrompt}</h2>
          <div className="pv-grid">
            <Field label={strings.promptKind}>
              <select
                className="pe-input"
                value={draft.promptKind}
                onChange={(event) =>
                  set('promptKind', event.target.value as SystemPromptDelivery['kind'])
                }
              >
                <option value="arg">{strings.promptKindArg}</option>
                <option value="agent-file">{strings.promptKindAgentFile}</option>
                <option value="codex-config">{strings.promptKindCodexConfig}</option>
                <option value="pty">{strings.promptKindPty}</option>
              </select>
            </Field>
            {draft.promptKind === 'arg' || draft.promptKind === 'agent-file' ? (
              <Field
                label={strings.promptFlag}
                error={editor.errors.promptFlag}
                hint={
                  draft.promptKind === 'agent-file' ? strings.promptAgentFileHint : undefined
                }
              >
                {text('promptFlag', {
                  placeholder:
                    draft.promptKind === 'agent-file' ? '--agent-file' : '--append-system-prompt'
                })}
              </Field>
            ) : (
              <p className="pe-hint pv-wide">
                {draft.promptKind === 'pty' ? strings.promptPtyHint : strings.promptCodexHint}
              </p>
            )}
          </div>
        </section>

        {/* --- mcp --- */}
        <section className="pv-section">
          <h2 className="pe-section-label">{strings.mcp}</h2>
          <div className="pv-grid">
            <Field label={strings.mcpKind}>
              <select
                className="pe-input"
                value={draft.mcpKind}
                onChange={(event) => set('mcpKind', event.target.value as McpAttach['kind'])}
              >
                <option value="claude-json">{strings.mcpKindClaudeJson}</option>
                <option value="codex-overrides">{strings.mcpKindCodexOverrides}</option>
                <option value="kimi-project">{strings.mcpKindKimiProject}</option>
                <option value="none">{strings.mcpKindNone}</option>
              </select>
            </Field>
            {draft.mcpKind === 'claude-json' ? (
              <>
                <Field label={strings.mcpConfigArg} error={editor.errors.mcpConfigArg}>
                  {text('mcpConfigArg', { placeholder: '--mcp-config' })}
                </Field>
                <Field
                  label={strings.mcpStrictArg}
                  error={editor.errors.mcpStrictArg}
                  hint={strings.mcpStrictArgHint}
                >
                  {text('mcpStrictArg', { placeholder: '--strict-mcp-config' })}
                </Field>
                <Field
                  label={strings.mcpAllowedToolsArg}
                  error={editor.errors.mcpAllowedToolsArg}
                  hint={strings.mcpAllowedToolsArgHint}
                >
                  {text('mcpAllowedToolsArg', { placeholder: '--allowedTools' })}
                </Field>
              </>
            ) : (
              <p className="pe-hint pv-wide">
                {draft.mcpKind === 'codex-overrides'
                  ? strings.mcpCodexHint
                  : draft.mcpKind === 'kimi-project'
                    ? strings.mcpKimiHint
                    : strings.mcpNoneHint}
              </p>
            )}
          </div>
        </section>

        {/* --- model discovery --- */}
        <section className="pv-section">
          <h2 className="pe-section-label">{strings.discovery}</h2>
          <div className="pv-grid">
            <Field label={strings.discoveryKind}>
              <select
                className="pe-input"
                value={draft.discoveryKind}
                onChange={(event) =>
                  set('discoveryKind', event.target.value as ModelDiscovery['kind'])
                }
              >
                <option value="none">{strings.discoveryNone}</option>
                <option value="cli">{strings.discoveryCli}</option>
                <option value="file">{strings.discoveryFile}</option>
                <option value="http">{strings.discoveryHttp}</option>
              </select>
            </Field>

            {draft.discoveryKind === 'cli' ? (
              <Field
                label={strings.discoveryArgs}
                error={editor.errors.discoveryArgs}
                hint={strings.discoveryArgsHint}
              >
                {lines('discoveryArgs', 2)}
              </Field>
            ) : null}

            {draft.discoveryKind === 'file' ? (
              <Field
                label={strings.discoveryPath}
                error={editor.errors.discoveryPath}
                hint={strings.discoveryPathHint}
              >
                {text('discoveryPath', { placeholder: '~/.codex/models_cache.json' })}
              </Field>
            ) : null}

            {draft.discoveryKind === 'http' ? (
              <Field label={strings.discoveryUrl} error={editor.errors.discoveryUrl}>
                {text('discoveryUrl', { placeholder: 'http://127.0.0.1:11434/api/tags' })}
              </Field>
            ) : null}

            {draft.discoveryKind === 'cli' || draft.discoveryKind === 'file' ? (
              <Field label={strings.discoveryParse} error={editor.errors.discoveryParse}>
                <select
                  className="pe-input"
                  value={draft.discoveryParse}
                  onChange={(event) =>
                    set('discoveryParse', event.target.value as ProviderDraft['discoveryParse'])
                  }
                >
                  {draft.discoveryKind === 'cli' ? (
                    <option value="lines">{strings.discoveryParseLines}</option>
                  ) : null}
                  <option value="json">{strings.discoveryParseJson}</option>
                  {draft.discoveryKind === 'file' ? (
                    <option value="toml-keys">{strings.discoveryParseTomlKeys}</option>
                  ) : null}
                </select>
              </Field>
            ) : null}

            {draft.discoveryKind !== 'none' ? (
              <Field
                label={strings.discoveryJsonPath}
                error={editor.errors.discoveryJsonPath}
                hint={strings.discoveryJsonPathHint}
              >
                {text('discoveryJsonPath', { placeholder: 'models[].name' })}
              </Field>
            ) : null}

            <Field
              label={strings.seedModels}
              error={editor.errors.seedModels}
              hint={strings.seedModelsHint}
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
            {strings.deleteProvider}
          </button>
        )}
        <span className="pe-foot-spacer" />
        <button type="button" className="pe-ghost" onClick={editor.cancel}>
          {strings.cancel}
        </button>
        <button type="button" className="pe-primary" onClick={editor.save} disabled={editor.saving}>
          {editor.saving ? strings.saving : strings.save}
        </button>
      </footer>
    </div>
  )
}
