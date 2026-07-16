import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { calculateKeyboardResizedWidth, ResizeHandle } from './ResizeHandle'
import { useLayoutStore } from '../store/layoutStore'

beforeEach(() => {
  useLayoutStore.setState({
    panels: {
      'sidebar-left': { width: 300, collapsed: false },
      'orchestrator-right': { width: 360, collapsed: false }
    }
  })
})

describe('ResizeHandle', () => {
  it('maps horizontal keys to the physical resize direction', () => {
    expect(calculateKeyboardResizedWidth('sidebar-left', 300, 'right', 'ArrowRight')).toBe(316)
    expect(calculateKeyboardResizedWidth('sidebar-left', 300, 'right', 'ArrowLeft')).toBe(284)
    expect(calculateKeyboardResizedWidth('orchestrator-right', 360, 'left', 'ArrowLeft')).toBe(376)
    expect(calculateKeyboardResizedWidth('orchestrator-right', 360, 'left', 'ArrowRight')).toBe(344)
  })

  it('supports limit shortcuts and ignores unrelated keys', () => {
    expect(calculateKeyboardResizedWidth('sidebar-left', 300, 'right', 'Home')).toBe(200)
    expect(calculateKeyboardResizedWidth('orchestrator-right', 360, 'left', 'End')).toBe(560)
    expect(calculateKeyboardResizedWidth('sidebar-left', 300, 'right', 'Enter')).toBeUndefined()
  })

  it('renders the separator semantics and current value', () => {
    const markup = renderToStaticMarkup(
      createElement(ResizeHandle, {
        panelId: 'sidebar-left',
        direction: 'right',
        ariaLabel: 'Sidebar-Breite ändern'
      })
    )

    expect(markup).toContain('role="separator"')
    expect(markup).toContain('aria-orientation="vertical"')
    expect(markup).toContain('aria-valuemin="200"')
    expect(markup).toContain('aria-valuemax="480"')
    expect(markup).toContain('aria-valuenow="300"')
    expect(markup).toContain('tabindex="0"')
  })
})
