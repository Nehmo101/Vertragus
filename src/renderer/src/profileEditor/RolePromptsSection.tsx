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
 * opens on load (`defaultOpen`) so a saved overlay is not hidden behind a
 * closed disclosure. The shipped role / loop prompt still applies; this is
 * only how the agent speaks and reports back in this profile.
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
        {identities.map((identity) => {
          const value = values[identity.id] ?? ''
          const filled = value.trim().length > 0
          return (
            <li key={identity.id}>
              <details className="pe-role-prompt" defaultOpen={filled}>
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
                    onChange={(event) => onChange(identity.id, event.target.value)}
                  />
                </div>
              </details>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
