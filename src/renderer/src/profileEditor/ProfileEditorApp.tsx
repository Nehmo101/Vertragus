import { useTranslation } from 'react-i18next'
import { DEFAULT_PR_REMOTE } from '@shared/schema/profile'
import { WORKER_ROLE_ID, roleColor } from '@shared/prompts/roles'
import { FolderIcon } from '../panel/icons'
import { EffortSelect, Field, ModelCombo, ProviderSelect, SwitchField } from './fields'
import {
  coerceRowEffort,
  newSlotDraft,
  promptIdentities,
  rowEffortOptions,
  type ProfileDraft,
  type SlotDraft
} from './model'
import { SlotRow } from './SlotRow'
import { RolePromptsSection } from './RolePromptsSection'
import { useProfileEditor } from './useProfileEditor'
import './profileEditor.css'

/**
 * The profile editor window.
 *
 * One sheet: identity (name + repo), the orchestrator, the slot blueprints,
 * per-identity system prompts, automation, and the profile-wide limit.
 * Saving validates against the same schema the store enforces and shows every
 * rejection on its field — a save that silently does nothing is the one
 * outcome this form must never have.
 */
export function ProfileEditorApp({
  profileId,
  providerHint
}: {
  profileId?: string
  /** WP-7: orchestrator preselection for a NEW profile; see the route. */
  providerHint?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const editor = useProfileEditor(profileId, providerHint)
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

  const updateSlot = (index: number, slot: SlotDraft): void =>
    editor.update((current) => ({
      ...current,
      slots: current.slots.map((entry, position) => (position === index ? slot : entry))
    }))

  const removeSlot = (index: number): void =>
    editor.update((current) => ({
      ...current,
      slots: current.slots.filter((_entry, position) => position !== index)
    }))

  const updateAutomation = (patch: Partial<ProfileDraft['automation']>): void =>
    editor.update((current) => ({
      ...current,
      automation: { ...current.automation, ...patch }
    }))

  const addSlot = (): void =>
    editor.update((current) => ({
      ...current,
      slots: [
        ...current.slots,
        newSlotDraft(WORKER_ROLE_ID, current.orchestrator.providerId)
      ]
    }))

  return (
    <div className="pe glass">
      <header className="pe-head">
        <h1 className="pe-title">{editor.isNew ? t('profileEditor.titleNew') : t('profileEditor.title')}</h1>
        <span className="pe-profile-name">{draft.name}</span>
      </header>

      <div className="pe-body">
        <Field label={t('profileEditor.name')} error={editor.errors.name}>
          <input
            className="pe-input"
            value={draft.name}
            placeholder={t('profileEditor.namePlaceholder')}
            onChange={(event) =>
              editor.update((current) => ({ ...current, name: event.target.value }))
            }
          />
        </Field>

        <Field label={t('profileEditor.repoPath')} error={editor.errors.repoPath}>
          <div className="pe-row">
            <input
              className="pe-input pe-mono"
              value={draft.repoPath}
              spellCheck={false}
              placeholder={t('profileEditor.repoPathPlaceholder')}
              onChange={(event) =>
                editor.update((current) => ({ ...current, repoPath: event.target.value }))
              }
            />
            <button
              type="button"
              className="pe-icon-button"
              title={t('profileEditor.pickFolder')}
              aria-label={t('profileEditor.pickFolder')}
              onClick={editor.pickFolder}
            >
              <FolderIcon />
            </button>
          </div>
        </Field>

        <section className="pe-orchestrator">
          <h2 className="pe-section-label">{t('profileEditor.orchestrator')}</h2>
          <p className="pe-hint">{t('profileEditor.orchestratorHint')}</p>
          <div className="pe-orchestrator-grid">
            <Field label={t('profileEditor.provider')} error={editor.errors['orchestrator.providerId']}>
              <ProviderSelect
                value={draft.orchestrator.providerId}
                providers={editor.providers}
                loading={editor.providersLoading}
                onChange={(providerId) =>
                  editor.update((current) => ({
                    ...current,
                    orchestrator: {
                      ...current.orchestrator,
                      providerId,
                      model: '',
                      effort: coerceRowEffort(
                        current.orchestrator.effort,
                        '',
                        providerId,
                        editor.providers,
                        editor.models,
                        editor.modelsLoading
                      )
                    }
                  }))
                }
              />
            </Field>
            <Field label={t('profileEditor.model')} error={editor.errors['orchestrator.model']}>
              <ModelCombo
                value={draft.orchestrator.model}
                catalogue={editor.models[draft.orchestrator.providerId]}
                loading={editor.modelsLoading[draft.orchestrator.providerId] ?? false}
                onReload={() => editor.reloadModels(draft.orchestrator.providerId)}
                onChange={(model) =>
                  editor.update((current) => ({
                    ...current,
                    orchestrator: {
                      ...current.orchestrator,
                      model,
                      effort: coerceRowEffort(
                        current.orchestrator.effort,
                        model,
                        current.orchestrator.providerId,
                        editor.providers,
                        editor.models,
                        editor.modelsLoading
                      )
                    }
                  }))
                }
              />
            </Field>
            <Field label={t('profileEditor.effort')}>
              <EffortSelect
                value={draft.orchestrator.effort}
                options={rowEffortOptions(
                  draft.orchestrator.model,
                  draft.orchestrator.providerId,
                  editor.providers,
                  editor.models[draft.orchestrator.providerId]
                )}
                onChange={(effort) =>
                  editor.update((current) => ({
                    ...current,
                    orchestrator: { ...current.orchestrator, effort }
                  }))
                }
              />
            </Field>
          </div>
        </section>

        <section className="pe-slots">
          <h2 className="pe-section-label">{t('profileEditor.slots')}</h2>
          <p className="pe-hint">{t('profileEditor.slotsHint')}</p>
          {draft.slots.length === 0 ? (
            <p className="pe-empty">{t('profileEditor.noSlots')}</p>
          ) : (
            <ul className="pe-slot-list">
              {draft.slots.map((slot, index) => (
                <SlotRow
                  key={slot.id}
                  slot={slot}
                  index={index}
                  roles={editor.roles}
                  providers={editor.providers}
                  providersLoading={editor.providersLoading}
                  models={editor.models}
                  modelsLoading={editor.modelsLoading}
                  onReloadModels={editor.reloadModels}
                  errors={editor.errors}
                  onChange={(next) => updateSlot(index, next)}
                  onRemove={() => removeSlot(index)}
                  onCreateRole={editor.saveCustomRole}
                />
              ))}
            </ul>
          )}
          <button type="button" className="pe-add-role" onClick={addSlot}>
            {t('profileEditor.addRole')}
          </button>

          <SwitchField
            label={t('profileEditor.autoSubmitTasks')}
            hint={t('profileEditor.autoSubmitTasksHint')}
            checked={draft.autoSubmitTasks}
            onChange={(autoSubmitTasks) =>
              editor.update((current) => ({ ...current, autoSubmitTasks }))
            }
          />
        </section>

        <RolePromptsSection
          identities={promptIdentities(editor.roles, roleColor)}
          values={draft.rolePrompts}
          errors={editor.errors}
          onChange={(roleId, prompt) =>
            editor.update((current) => ({
              ...current,
              rolePrompts: { ...current.rolePrompts, [roleId]: prompt }
            }))
          }
        />

        <section className="pe-automation">
          <h2 className="pe-section-label">{t('profileEditor.automation')}</h2>
          <p className="pe-hint">{t('profileEditor.automationHint')}</p>

          <SwitchField
            label={t('profileEditor.autoIntegrate')}
            hint={t('profileEditor.autoIntegrateHint')}
            checked={draft.automation.autoIntegrate}
            onChange={(autoIntegrate) => updateAutomation({ autoIntegrate })}
          />
          <SwitchField
            label={t('profileEditor.autoPromote')}
            hint={t('profileEditor.autoPromoteHint')}
            checked={draft.automation.autoPromote}
            onChange={(autoPromote) => updateAutomation({ autoPromote })}
          />
          <SwitchField
            label={t('profileEditor.autoPr')}
            hint={t('profileEditor.autoPrHint')}
            checked={draft.automation.autoPr}
            onChange={(autoPr) => updateAutomation({ autoPr })}
          />
          {/* The three PR details only exist for an auto-PR — showing them
              while the switch is off would offer settings that change nothing. */}
          {draft.automation.autoPr ? (
            <>
              <Field
                label={t('profileEditor.prBaseBranch')}
                error={editor.errors['automation.prBaseBranch']}
              >
                <input
                  className="pe-input"
                  value={draft.automation.prBaseBranch}
                  placeholder={t('profileEditor.prBaseBranchPlaceholder')}
                  onChange={(event) => updateAutomation({ prBaseBranch: event.target.value })}
                />
              </Field>
              <Field label={t('profileEditor.prRemote')} error={editor.errors['automation.prRemote']}>
                <input
                  className="pe-input"
                  value={draft.automation.prRemote}
                  placeholder={DEFAULT_PR_REMOTE}
                  onChange={(event) => updateAutomation({ prRemote: event.target.value })}
                />
              </Field>
              <SwitchField
                label={t('profileEditor.prDraft')}
                hint={t('profileEditor.prDraftHint')}
                checked={draft.automation.prDraft}
                onChange={(prDraft) => updateAutomation({ prDraft })}
              />
            </>
          ) : null}
        </section>

        <Field label={t('profileEditor.maxSubagents')} error={editor.errors.maxSubagents}>
          <input
            className="pe-input pe-max-subagents"
            value={draft.maxSubagents}
            inputMode="numeric"
            placeholder={t('profileEditor.maxSubagentsPlaceholder')}
            onChange={(event) =>
              editor.update((current) => ({ ...current, maxSubagents: event.target.value }))
            }
          />
        </Field>

        {editor.errors.form ? <p className="pe-error pe-error-form">{editor.errors.form}</p> : null}
      </div>

      <footer className="pe-foot">
        {editor.isNew ? null : (
          <button type="button" className="pe-danger" onClick={editor.remove}>
            {t('profileEditor.deleteProfile')}
          </button>
        )}
        {/* Zones are drawn on the real screens, so this only opens the overlay
            session — it saves nothing here. A profile that does not exist yet
            has nothing to attach a layout to. */}
        <button
          type="button"
          className="pe-ghost"
          title={editor.isNew ? t('profileEditor.zonesNewHint') : t('profileEditor.zonesTitle')}
          disabled={editor.isNew || !profileId}
          onClick={() => {
            if (profileId) void window.vertragus?.app.editZones(profileId)
          }}
        >
          {t('profileEditor.zones')}
        </button>
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
