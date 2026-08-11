import { WORKER_ROLE_ID } from '@shared/prompts/roles'
import { FolderIcon } from '../panel/icons'
import { EffortSelect, Field, ModelCombo, ProviderSelect, SwitchField } from './fields'
import { newSlotDraft, type SlotDraft } from './model'
import { SlotRow } from './SlotRow'
import { EDITOR_STRINGS } from './strings'
import { useProfileEditor } from './useProfileEditor'
import './profileEditor.css'

/**
 * The profile editor window.
 *
 * One sheet, four bands: identity (name + repo), the orchestrator, the slot
 * blueprints, and the profile-wide limit. Saving validates against the same
 * schema the store enforces and shows every rejection on its field — a save
 * that silently does nothing is the one outcome this form must never have.
 */
export function ProfileEditorApp({ profileId }: { profileId?: string }): React.JSX.Element {
  const editor = useProfileEditor(profileId)
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
        <p className="pe-fatal">{EDITOR_STRINGS.loading}</p>
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
        <h1 className="pe-title">{editor.isNew ? EDITOR_STRINGS.titleNew : EDITOR_STRINGS.title}</h1>
        <span className="pe-profile-name">{draft.name}</span>
      </header>

      <div className="pe-body">
        <Field label={EDITOR_STRINGS.name} error={editor.errors.name}>
          <input
            className="pe-input"
            value={draft.name}
            placeholder={EDITOR_STRINGS.namePlaceholder}
            onChange={(event) =>
              editor.update((current) => ({ ...current, name: event.target.value }))
            }
          />
        </Field>

        <Field label={EDITOR_STRINGS.repoPath} error={editor.errors.repoPath}>
          <div className="pe-row">
            <input
              className="pe-input pe-mono"
              value={draft.repoPath}
              spellCheck={false}
              placeholder={EDITOR_STRINGS.repoPathPlaceholder}
              onChange={(event) =>
                editor.update((current) => ({ ...current, repoPath: event.target.value }))
              }
            />
            <button
              type="button"
              className="pe-icon-button"
              title={EDITOR_STRINGS.pickFolder}
              aria-label={EDITOR_STRINGS.pickFolder}
              onClick={editor.pickFolder}
            >
              <FolderIcon />
            </button>
          </div>
        </Field>

        <section className="pe-orchestrator">
          <h2 className="pe-section-label">{EDITOR_STRINGS.orchestrator}</h2>
          <p className="pe-hint">{EDITOR_STRINGS.orchestratorHint}</p>
          <div className="pe-orchestrator-grid">
            <Field label={EDITOR_STRINGS.provider} error={editor.errors['orchestrator.providerId']}>
              <ProviderSelect
                value={draft.orchestrator.providerId}
                providers={editor.providers}
                loading={editor.providersLoading}
                onChange={(providerId) =>
                  editor.update((current) => ({
                    ...current,
                    orchestrator: { ...current.orchestrator, providerId, model: '' }
                  }))
                }
              />
            </Field>
            <Field label={EDITOR_STRINGS.model} error={editor.errors['orchestrator.model']}>
              <ModelCombo
                value={draft.orchestrator.model}
                catalogue={editor.models[draft.orchestrator.providerId]}
                loading={editor.modelsLoading[draft.orchestrator.providerId] ?? false}
                onReload={() => editor.reloadModels(draft.orchestrator.providerId)}
                onChange={(model) =>
                  editor.update((current) => ({
                    ...current,
                    orchestrator: { ...current.orchestrator, model }
                  }))
                }
              />
            </Field>
            <Field label={EDITOR_STRINGS.effort}>
              <EffortSelect
                value={draft.orchestrator.effort}
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
          <h2 className="pe-section-label">{EDITOR_STRINGS.slots}</h2>
          <p className="pe-hint">{EDITOR_STRINGS.slotsHint}</p>
          {draft.slots.length === 0 ? (
            <p className="pe-empty">{EDITOR_STRINGS.noSlots}</p>
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
            {EDITOR_STRINGS.addRole}
          </button>

          <SwitchField
            label={EDITOR_STRINGS.autoSubmitTasks}
            hint={EDITOR_STRINGS.autoSubmitTasksHint}
            checked={draft.autoSubmitTasks}
            onChange={(autoSubmitTasks) =>
              editor.update((current) => ({ ...current, autoSubmitTasks }))
            }
          />
        </section>

        <Field label={EDITOR_STRINGS.maxSubagents} error={editor.errors.maxSubagents}>
          <input
            className="pe-input pe-max-subagents"
            value={draft.maxSubagents}
            inputMode="numeric"
            placeholder={EDITOR_STRINGS.maxSubagentsPlaceholder}
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
            {EDITOR_STRINGS.deleteProfile}
          </button>
        )}
        {/* Zones are drawn on the real screens, so this only opens the overlay
            session — it saves nothing here. A profile that does not exist yet
            has nothing to attach a layout to. */}
        <button
          type="button"
          className="pe-ghost"
          title={editor.isNew ? EDITOR_STRINGS.zonesNewHint : EDITOR_STRINGS.zonesTitle}
          disabled={editor.isNew || !profileId}
          onClick={() => {
            if (profileId) void window.vertragus?.app.editZones(profileId)
          }}
        >
          {EDITOR_STRINGS.zones}
        </button>
        <span className="pe-foot-spacer" />
        <button type="button" className="pe-ghost" onClick={editor.cancel}>
          {EDITOR_STRINGS.cancel}
        </button>
        <button type="button" className="pe-primary" onClick={editor.save} disabled={editor.saving}>
          {editor.saving ? EDITOR_STRINGS.saving : EDITOR_STRINGS.save}
        </button>
      </footer>
    </div>
  )
}
