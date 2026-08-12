import { useTranslation } from 'react-i18next'
import type { Profile } from '@shared/schema/profile'
import type { VertragusAppApi } from '../../../preload'
import { BroomIcon, GearIcon, PlayIcon } from './icons'
import { WorktreeCleanup } from './WorktreeCleanup'

interface Props {
  profile: Profile
  /** How many workspaces currently belong to this profile. */
  count: number
  /** Whether this profile is the active workspace filter. */
  selected: boolean
  onSelect(profileId: string): void
  onStart(profileId: string): void
  onEdit(profileId: string): void
  /** True while this row's worktree cleanup list is unfolded below it. */
  cleanupOpen: boolean
  onToggleCleanup(profileId: string): void
  /** Bridge for the cleanup list; absent only when preload never loaded. */
  bridge?: VertragusAppApi
}

/**
 * One profile line: name + workspace count (toggles the filter), Play (opens
 * another workspace — pressing it twice gives two), broom (the worktree
 * cleanup list, folded out below), gear (profile editor). Play is deliberately
 * the visually loudest control in the panel; it is the one thing the app exists
 * to do. Name/count stay a sibling of the three buttons so filter clicks never
 * hit those targets, and the selected wash sits on the row itself so the
 * unfolded cleanup list below it stays visually outside the selection.
 */
export function ProfileRow({
  profile,
  count,
  selected,
  onSelect,
  onStart,
  onEdit,
  cleanupOpen,
  onToggleCleanup,
  bridge
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const start = t('panel.startWorkspace', { profile: profile.name })
  const edit = t('panel.editProfile', { profile: profile.name })
  const filter = t('panel.filterProfileWorkspaces', { profile: profile.name })
  const cleanup = t('panel.cleanupWorktrees', { profile: profile.name })
  return (
    <li className="panel-row-group">
      <div className={selected ? 'panel-row is-selected' : 'panel-row'}>
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
          className={`panel-icon-button${cleanupOpen ? ' is-active' : ''}`}
          title={cleanup}
          aria-label={cleanup}
          aria-expanded={cleanupOpen}
          onClick={() => onToggleCleanup(profile.id)}
        >
          <BroomIcon />
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
      </div>
      {cleanupOpen && bridge ? (
        <WorktreeCleanup key={profile.id} profileId={profile.id} bridge={bridge} />
      ) : null}
    </li>
  )
}
