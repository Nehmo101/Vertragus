import type { KeyboardEvent } from 'react'
import {
  PANEL_LIMITS,
  clampPanelWidth,
  selectPanelWidth,
  useLayoutStore,
  type PanelId
} from '../store/layoutStore'
import { useResizablePanel, type ResizeDirection } from '../hooks/useResizablePanel'
import styles from './ResizeHandle.module.css'

const KEYBOARD_RESIZE_STEP = 16

export function calculateKeyboardResizedWidth(
  panelId: PanelId,
  currentWidth: number,
  direction: ResizeDirection,
  key: string
): number | undefined {
  const limits = PANEL_LIMITS[panelId]

  switch (key) {
    case 'ArrowLeft':
      return clampPanelWidth(
        panelId,
        currentWidth + (direction === 'left' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP)
      )
    case 'ArrowRight':
      return clampPanelWidth(
        panelId,
        currentWidth + (direction === 'right' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP)
      )
    case 'Home':
      return limits.minWidth
    case 'End':
      return limits.maxWidth
    default:
      return undefined
  }
}

export interface ResizeHandleProps {
  panelId: PanelId
  direction: ResizeDirection
  ariaLabel: string
  className?: string
}

export function ResizeHandle({
  panelId,
  direction,
  ariaLabel,
  className
}: ResizeHandleProps): React.JSX.Element {
  const width = useLayoutStore(selectPanelWidth(panelId))
  const setWidth = useLayoutStore((state) => state.setWidth)
  const { onPointerDown, onDoubleClick, isResizing } = useResizablePanel({
    panelId,
    direction
  })
  const limits = PANEL_LIMITS[panelId]

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const currentWidth = useLayoutStore.getState().panels[panelId].width
    const nextWidth = calculateKeyboardResizedWidth(panelId, currentWidth, direction, event.key)
    if (nextWidth === undefined) return

    event.preventDefault()
    setWidth(panelId, nextWidth)
  }

  const classes = [styles.handle, className].filter(Boolean).join(' ')

  return (
    <div
      className={classes}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuemin={limits.minWidth}
      aria-valuemax={limits.maxWidth}
      aria-valuenow={width}
      data-active={isResizing || undefined}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    />
  )
}
