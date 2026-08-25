import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
 * Folded by default so the sheet stays a slot editor first. A filled prompt
 * opens on first paint so a saved overlay is not hidden behind a closed
 * disclosure. The shipped role / loop prompt still applies; this is only how
 * the agent speaks and reports back in this profile.
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
  // React's DetailsHTMLAttributes has `open` but not `defaultOpen`, so the
  // initial-open-when-filled behaviour is a small controlled fold.
  const [open, setOpen] = useState(filled)

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
      </div>
    </details>
  )
}
