import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentInstanceInfo } from '@shared/agents'
import AgentPane from './AgentPane'
import { useLayoutStore } from '@renderer/store/layoutStore'

interface Props {
  agent: AgentInstanceInfo | null
  onClose: () => void
}

export default function CanvasTerminalDrawer({ agent, onClose }: Props): JSX.Element | null {
  const { t } = useTranslation()
  const height = useLayoutStore((state) => state.terminalDrawerHeight)
  const setHeight = useLayoutStore((state) => state.setTerminalDrawerHeight)
  const start = useRef<{ y: number; height: number } | null>(null)

  useEffect(() => {
    if (!agent) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [agent, onClose])

  if (!agent) return null

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    start.current = { y: event.clientY, height }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!start.current) return
    setHeight(start.current.height + ((start.current.y - event.clientY) / window.innerHeight) * 100)
  }

  return (
    <section className="canvas-terminal-drawer" style={{ height: `${height}%` }} aria-label={t('canvas.drawer.aria')}>
      <div
        className="canvas-terminal-resize"
        role="separator"
        aria-label={t('canvas.drawer.resize')}
        aria-orientation="horizontal"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => { start.current = null }}
        onDoubleClick={() => setHeight(45)}
      />
      <button type="button" className="canvas-terminal-close" onClick={onClose} aria-label={t('canvas.drawer.close')}>×</button>
      <AgentPane agent={agent} focused onFocus={() => undefined} />
    </section>
  )
}
