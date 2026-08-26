import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { roleColor } from '@shared/prompts/roles'
import type { RoleTemplate } from '@shared/schema/profile'
import type { ModelDiscoveryResult, ProviderListEntry } from '../../../preload'
import { EffortSelect, ModelCombo, ProviderSelect } from './fields'
import {
  CUSTOM_ROLE_VALUE,
  coerceRowEffort,
  customRoleTemplate,
  rowEffortOptions,
  type DraftErrors,
  type SlotDraft
} from './model'

interface Props {
  slot: SlotDraft
  index: number
  roles: RoleTemplate[]
  providers: ProviderListEntry[]
  providersLoading: boolean
  models: Record<string, ModelDiscoveryResult>
  modelsLoading: Record<string, boolean>
  errors: DraftErrors
  onChange(slot: SlotDraft): void
  onRemove(): void
  onReloadModels(providerId: string): void
  onCreateRole(template: RoleTemplate): Promise<RoleTemplate | null>
}

/**
 * One slot — role, provider, model, instance cap.
 *
 * A slot is a BLUEPRINT: "reviewers run on codex, at most two". It does not
 * start anything; the orchestrator decides how many instances it needs within
 * `Max` and the profile-wide limit. The role select carries the role's accent
 * colour on its edge, which is the same colour the agent's window and status
 * dot will have later — the profile is where you learn the colour code.
 */
export function SlotRow({
  slot,
  index,
  roles,
  providers,
  providersLoading,
  models,
  modelsLoading,
  errors,
  onChange,
  onRemove,
  onReloadModels,
  onCreateRole
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [customName, setCustomName] = useState('')
  const [customPrompt, setCustomPrompt] = useState('')
  const [customOpen, setCustomOpen] = useState(false)
  const [customError, setCustomError] = useState<string | null>(null)

  const color = roleColor(slot.roleId, index)
  const roleError = errors[`slots.${index}.roleId`]
  const modelError = errors[`slots.${index}.model`]
  const maxError = errors[`slots.${index}.maxCount`]

  const submitCustomRole = async (): Promise<void> => {
    if (!customName.trim()) {
      setCustomError(t('profileEditor.errors.customRoleName'))
      return
    }
    if (!customPrompt.trim()) {
      setCustomError(t('profileEditor.errors.customRolePrompt'))
      return
    }
    const template = customRoleTemplate(customName, customPrompt)
    const saved = await onCreateRole(template)
    if (!saved) return
    setCustomOpen(false)
    setCustomName('')
    setCustomPrompt('')
    setCustomError(null)
    onChange({ ...slot, roleId: saved.id })
  }

  return (
    <li className="pe-slot">
      <div className="pe-slot-grid">
        <select
          className="pe-input pe-role"
          style={{ borderColor: color, color }}
          value={customOpen ? CUSTOM_ROLE_VALUE : slot.roleId}
          onChange={(event) => {
            const value = event.target.value
            if (value === CUSTOM_ROLE_VALUE) {
              setCustomOpen(true)
              return
            }
            setCustomOpen(false)
            onChange({ ...slot, roleId: value })
          }}
        >
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
          <option value={CUSTOM_ROLE_VALUE}>{t('profileEditor.customRole')}</option>
        </select>

        <ProviderSelect
          value={slot.providerId}
          providers={providers}
          loading={providersLoading}
          onChange={(providerId) =>
            onChange({
              ...slot,
              providerId,
              model: '',
              effort: coerceRowEffort(
                slot.effort,
                '',
                providerId,
                providers,
                models,
                modelsLoading
              )
            })
          }
        />

        <ModelCombo
          value={slot.model}
          catalogue={models[slot.providerId]}
          loading={modelsLoading[slot.providerId] ?? false}
          onReload={() => onReloadModels(slot.providerId)}
          // A healthy row stays one line high; only a problem earns a caption.
          quietWhenHealthy
          onChange={(model) =>
            onChange({
              ...slot,
              model,
              effort: coerceRowEffort(slot.effort, model, slot.providerId, providers, models, modelsLoading)
            })
          }
        />

        <input
          className="pe-input pe-max"
          value={slot.maxCount}
          inputMode="numeric"
          placeholder="∞"
          title={t('profileEditor.maxTitle')}
          aria-label={t('profileEditor.max')}
          onChange={(event) => onChange({ ...slot, maxCount: event.target.value })}
        />

        <EffortSelect
          value={slot.effort}
          options={rowEffortOptions(slot.model, slot.providerId, providers, models[slot.providerId])}
          onChange={(effort) => onChange({ ...slot, effort })}
          className="pe-input pe-effort"
        />

        <button
          type="button"
          className="pe-remove"
          title={t('profileEditor.removeSlot')}
          aria-label={t('profileEditor.removeSlot')}
          onClick={onRemove}
        >
          ×
        </button>
      </div>

      {roleError || modelError || maxError ? (
        <p className="pe-error">{roleError ?? modelError ?? maxError}</p>
      ) : null}

      {customOpen ? (
        <div className="pe-custom-role">
          <input
            className="pe-input"
            value={customName}
            placeholder={t('profileEditor.customRoleName')}
            onChange={(event) => setCustomName(event.target.value)}
          />
          <textarea
            className="pe-input pe-textarea"
            value={customPrompt}
            rows={4}
            placeholder={t('profileEditor.customRolePromptPlaceholder')}
            onChange={(event) => setCustomPrompt(event.target.value)}
          />
          {customError ? <p className="pe-error">{customError}</p> : null}
          <div className="pe-custom-actions">
            <button type="button" className="pe-ghost" onClick={() => setCustomOpen(false)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="pe-secondary" onClick={() => void submitCustomRole()}>
              {t('profileEditor.customRoleSave')}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
