import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProfileSkill } from '@shared/profile'
import InfoTip from '@renderer/components/InfoTip'
import { HELP } from './help'

interface SkillsSectionProps {
  /** Legacy drafts may predate the skills field. */
  skills?: ProfileSkill[]
  onPatchSkill: (index: number, patch: Partial<ProfileSkill>) => void
  onAddSkill: () => void
  onRemoveSkill: (index: number) => void
}

/** Profile skills: named workspace procedures for orchestrator/solo prompts. */
const SkillsSection = memo(function SkillsSection({
  skills,
  onPatchSkill,
  onAddSkill,
  onRemoveSkill
}: SkillsSectionProps): JSX.Element {
  const { t } = useTranslation()
  const list = skills ?? []
  return (
    <section className="automation-section" aria-labelledby="skills-heading">
      <div className="slots-caption compact-caption">
        <span id="skills-heading">
          {t('profile.skills.heading')} <InfoTip text={t(HELP.skills)} />
        </span>
        <span className="count">{list.length} / 24</span>
      </div>
      {list.map((skill, index) => (
        <div className="slot-path-row" key={skill.id}>
          <div className="slot-path-field">
            <input
              className="slot-select-sm"
              placeholder={t('profile.skills.namePlaceholder')}
              value={skill.name}
              maxLength={80}
              onChange={(event) => onPatchSkill(index, { name: event.target.value })}
            />
            <textarea
              className="slot-select-sm"
              rows={2}
              placeholder={t('profile.skills.instructionsPlaceholder')}
              value={skill.instructions}
              maxLength={2000}
              onChange={(event) => onPatchSkill(index, { instructions: event.target.value })}
            />
            <div className="model-effective">
              {skill.source === 'orchestrator' ? t('profile.skills.learned') : t('profile.skills.manual')}
            </div>
          </div>
          <button
            type="button"
            className="inbox-btn ghost"
            aria-label={t('profile.skills.removeAria', { name: skill.name || index + 1 })}
            onClick={() => onRemoveSkill(index)}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ghost-btn"
        disabled={list.length >= 24}
        onClick={() => onAddSkill()}
      >
        {t('profile.skills.add')}
      </button>
    </section>
  )
})

export default SkillsSection
