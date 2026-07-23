import { memo } from 'react'
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

/** Profil-Skills: benannte Workspace-Verfahren für Orchestrator-/Solo-Prompts. */
const SkillsSection = memo(function SkillsSection({
  skills,
  onPatchSkill,
  onAddSkill,
  onRemoveSkill
}: SkillsSectionProps): JSX.Element {
  const list = skills ?? []
  return (
    <section className="automation-section" aria-labelledby="skills-heading">
      <div className="slots-caption compact-caption">
        <span id="skills-heading">
          Profil-Skills <InfoTip text={HELP.skills} />
        </span>
        <span className="count">{list.length} / 24</span>
      </div>
      {list.map((skill, index) => (
        <div className="slot-path-row" key={skill.id}>
          <div className="slot-path-field">
            <input
              className="slot-select-sm"
              placeholder="Skill-Name, z. B. Deploy-Ablauf"
              value={skill.name}
              maxLength={80}
              onChange={(event) => onPatchSkill(index, { name: event.target.value })}
            />
            <textarea
              className="slot-select-sm"
              rows={2}
              placeholder="Wann anwenden + konkrete Schritte"
              value={skill.instructions}
              maxLength={2000}
              onChange={(event) => onPatchSkill(index, { instructions: event.target.value })}
            />
            <div className="model-effective">
              {skill.source === 'orchestrator' ? 'Vom Orchestrator gelernt' : 'Manuell angelegt'}
            </div>
          </div>
          <button
            type="button"
            className="inbox-btn ghost"
            aria-label={`Skill ${skill.name || index + 1} entfernen`}
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
        ＋ Skill hinzufügen
      </button>
    </section>
  )
})

export default SkillsSection
