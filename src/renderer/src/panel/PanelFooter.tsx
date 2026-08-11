import { EyeIcon, GearIcon } from './icons'
import { PANEL_STRINGS } from './strings'

interface Props {
  yolo: boolean
  onToggleYolo(): void
  onHideAll(): void
}

/**
 * The footer carries the two switches that act on EVERY window at once: the
 * Yolo master (subagents may act without asking) and hide-all. They are red and
 * quiet respectively — the dangerous one is the one you can see from across the
 * room.
 */
export function PanelFooter({ yolo, onToggleYolo, onHideAll }: Props): React.JSX.Element {
  return (
    <footer className="panel-footer">
      <button
        type="button"
        className={`panel-yolo${yolo ? ' is-on' : ''}`}
        role="switch"
        aria-checked={yolo}
        title={yolo ? PANEL_STRINGS.yoloOn : PANEL_STRINGS.yoloOff}
        onClick={onToggleYolo}
      >
        <span className="panel-yolo-track">
          <span className="panel-yolo-knob" />
        </span>
        <span className="panel-yolo-label">{PANEL_STRINGS.yolo}</span>
      </button>
      <span className="panel-footer-spacer" />
      <button
        type="button"
        className="panel-icon-button"
        title={PANEL_STRINGS.hideAll}
        aria-label={PANEL_STRINGS.hideAll}
        onClick={onHideAll}
      >
        <EyeIcon />
      </button>
      <button
        type="button"
        className="panel-icon-button"
        title={PANEL_STRINGS.settingsSoon}
        aria-label={PANEL_STRINGS.settings}
        disabled
      >
        <GearIcon />
      </button>
    </footer>
  )
}
