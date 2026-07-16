import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEventHandler, PointerEventHandler } from 'react'
import {
  PANEL_LIMITS,
  clampPanelWidth,
  useLayoutStore,
  type PanelId
} from '../store/layoutStore'

export type ResizeDirection = 'left' | 'right'

export interface UseResizablePanelOptions {
  panelId: PanelId
  direction: ResizeDirection
}

export interface ResizablePanelHandlers {
  onPointerDown: PointerEventHandler<HTMLDivElement>
  onDoubleClick: MouseEventHandler<HTMLDivElement>
  isResizing: boolean
}

interface ActiveDrag {
  element: HTMLDivElement
  pointerId: number
  removeListeners: () => void
}

export function calculateResizedWidth(
  panelId: PanelId,
  initialWidth: number,
  initialPointerX: number,
  pointerX: number,
  direction: ResizeDirection
): number {
  const pointerDelta = pointerX - initialPointerX
  const widthDelta = direction === 'right' ? pointerDelta : -pointerDelta
  return clampPanelWidth(panelId, initialWidth + widthDelta)
}

export function useResizablePanel({
  panelId,
  direction
}: UseResizablePanelOptions): ResizablePanelHandlers {
  const activeDrag = useRef<ActiveDrag | null>(null)
  const [isResizing, setIsResizing] = useState(false)

  const finishResize = useCallback((updateState: boolean) => {
    const drag = activeDrag.current
    if (!drag) return

    activeDrag.current = null
    drag.removeListeners()
    if (drag.element.hasPointerCapture(drag.pointerId)) {
      drag.element.releasePointerCapture(drag.pointerId)
    }
    if (updateState) setIsResizing(false)
  }, [])

  useEffect(() => () => finishResize(false), [finishResize])

  const onPointerDown = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.button !== 0 || !event.isPrimary) return

      finishResize(true)
      event.preventDefault()

      const element = event.currentTarget
      const pointerId = event.pointerId
      const initialPointerX = event.clientX
      const initialWidth = useLayoutStore.getState().panels[panelId].width

      const onPointerMove = (pointerEvent: PointerEvent): void => {
        if (pointerEvent.pointerId !== pointerId) return
        const width = calculateResizedWidth(
          panelId,
          initialWidth,
          initialPointerX,
          pointerEvent.clientX,
          direction
        )
        useLayoutStore.getState().setWidth(panelId, width)
      }

      const onPointerEnd = (pointerEvent: PointerEvent): void => {
        if (pointerEvent.pointerId === pointerId) finishResize(true)
      }

      const removeListeners = (): void => {
        element.removeEventListener('pointermove', onPointerMove)
        element.removeEventListener('pointerup', onPointerEnd)
        element.removeEventListener('pointercancel', onPointerEnd)
        element.removeEventListener('lostpointercapture', onPointerEnd)
      }

      element.addEventListener('pointermove', onPointerMove)
      element.addEventListener('pointerup', onPointerEnd)
      element.addEventListener('pointercancel', onPointerEnd)
      element.addEventListener('lostpointercapture', onPointerEnd)
      activeDrag.current = { element, pointerId, removeListeners }
      element.setPointerCapture(pointerId)
      setIsResizing(true)
    },
    [direction, finishResize, panelId]
  )

  const onDoubleClick = useCallback<MouseEventHandler<HTMLDivElement>>(() => {
    useLayoutStore.getState().setWidth(panelId, PANEL_LIMITS[panelId].defaultWidth)
  }, [panelId])

  return { onPointerDown, onDoubleClick, isResizing }
}
