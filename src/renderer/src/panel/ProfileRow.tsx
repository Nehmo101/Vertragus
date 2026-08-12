import { useTranslation } from 'react-i18next'
import type { Profile } from '@shared/schema/profile'
import { GearIcon, PlayIcon } from './icons'

interface Props {
  profile: Profile
  /** How many workspaces currently belong to this profile. */
  count: number
  /** Whether this profile is the active workspace filter. */
  selected: boolean
  onSelect(profileId: string): void
  onStart(profileId: string): void
  onEdit(profileId: string): void
}

/**
 * One profile line: name + workspace count (toggles the filter), Play (opens
 * another workspace — pressing it twice gives two), gear (profile editor).
 * Play is deliberately the visually loudest control in the panel; it is the
 * one thing the app exists to do. Name/count stay a sibling of Play and Gear
 * so filter clicks never hit those targets.
 */
export function ProfileRow({
  profile,
  count,
  selected,
  onSelect,
  onStart,
  onEdit
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const start = t('panel.startWorkspace', { profile: profile.name })
  const edit = t('panel.editProfile', { profile: profile.name })
  const filter = t('panel.filterProfileWorkspaces', { profile: profile.name })
  return (
    <li className={selected ? 'panel-row is-selected' : 'panel-row'}>
      <button
        type="button"
        className="panel-row-select"
        title={filter}
        aria-label={filter}
        aria-pressed={selected}
        onClick={() => onSelect(profile.id)}
      >
        <span className="panel-row-name" title={profile.repoPath || undefined}>
          {profile.name}
        </span>
        <span className="panel-row-count">{count}</span>
      </button>
      <button
        type="button"
        className="panel-play"
        title={start}
        aria-label={start}
        onClick={() => onStart(profile.id)}
      >
        <PlayIcon />
      </button>
      <button
        type="button"
        className="panel-icon-button"
        title={edit}
        aria-label={edit}
        onClick={() => onEdit(profile.id)}
      >
        <GearIcon />
      </button>
    </li>
  )
}
