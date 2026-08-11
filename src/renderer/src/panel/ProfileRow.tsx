import type { Profile } from '@shared/schema/profile'
import { GearIcon, PlayIcon } from './icons'
import { PANEL_STRINGS } from './strings'

interface Props {
  profile: Profile
  onStart(profileId: string): void
  onEdit(profileId: string): void
}

/**
 * One profile line: name, Play (opens another workspace — pressing it twice
 * gives two), gear (profile editor). Play is deliberately the visually loudest
 * control in the panel; it is the one thing the app exists to do.
 */
export function ProfileRow({ profile, onStart, onEdit }: Props): React.JSX.Element {
  return (
    <li className="panel-row">
      <span className="panel-row-name" title={profile.repoPath || undefined}>
        {profile.name}
      </span>
      <button
        type="button"
        className="panel-play"
        title={PANEL_STRINGS.startWorkspace(profile.name)}
        aria-label={PANEL_STRINGS.startWorkspace(profile.name)}
        onClick={() => onStart(profile.id)}
      >
        <PlayIcon />
      </button>
      <button
        type="button"
        className="panel-icon-button"
        title={PANEL_STRINGS.editProfile(profile.name)}
        aria-label={PANEL_STRINGS.editProfile(profile.name)}
        onClick={() => onEdit(profile.id)}
      >
        <GearIcon />
      </button>
    </li>
  )
}
