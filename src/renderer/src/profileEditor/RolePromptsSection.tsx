import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { starterRolePrompt } from '@shared/prompts/rolePrompt'
import type { DraftErrors, RoleOption } from './model'

interface Props {
  identities: RoleOption[]
  values: Record<string, string>
  errors: DraftErrors
  onChange(roleId: string, prompt: string): void
}

/**
 * Extra system prompt per identity — Orchestrator, Lead, and every role.
 *
 * Folded by default so the sheet stays a slot editor first. New profiles
 * arrive with starter text (badge "set"); the fold stays closed so nine
 * open textareas do not bury the slots. The shipped role / loop prompt
 * still applies underneath.
 */
export function RolePromptsSection({
  identities,
  values,
  errors,
  onChange
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const sectionError = Object.entries(errors).find(([path]) => path.startsWith('rolePrompts'))?.[1]

  return (
    <section className="pe-role-prompts">
      <h2 className="pe-section-label">{t('profileEditor.rolePrompts')}</h2>
      <p className="pe-hint">{t('profileEditor.rolePromptsHint')}</p>
      {sectionError ? <p className="pe-error">{sectionError}</p> : null}
      <ul className="pe-role-prompt-list">
        {identities.map((identity) => (
          <li key={identity.id}>
            <RolePromptFold
              identity={identity}
              value={values[identity.id] ?? ''}
              onChange={(prompt) => onChange(identity.id, prompt)}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

function RolePromptFold({
  identity,
  value,
  onChange
}: {
  identity: RoleOption
  value: string
  onChange(prompt: string): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const filled = value.trim().length > 0
  const starter = starterRolePrompt(identity.id)
  const atStarter = Boolean(starter) && value.trim() === starter!.trim()
  // Always start closed — a new profile has every identity filled, and
  // opening them all would bury the rest of the sheet.
  const [open, setOpen] = useState(false)

  return (
    <details
      className="pe-role-prompt"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="pe-role-prompt-summary">
        <span
          className="pe-role-prompt-dot"
          style={{ background: identity.color }}
          aria-hidden="true"
        />
        <span className="pe-role-prompt-name">{identity.name}</span>
        {filled ? (
          <span className="pe-role-prompt-set">{t('profileEditor.rolePromptSet')}</span>
        ) : null}
      </summary>
      <div className="pe-role-prompt-body">
        <textarea
          className="pe-input pe-textarea"
          value={value}
          rows={5}
          placeholder={t('profileEditor.rolePromptPlaceholder')}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        {starter && !atStarter ? (
          <button
            type="button"
            className="pe-ghost pe-role-prompt-restore"
            onClick={() => onChange(starter)}
          >
            {t('profileEditor.rolePromptRestore')}
          </button>
        ) : null}
      </div>
    </details>
  )
}
