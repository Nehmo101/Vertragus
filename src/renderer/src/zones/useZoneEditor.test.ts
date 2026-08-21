import { describe, expect, it } from 'vitest'
import { applyGesture } from './useZoneEditor'
import type { DraftZone, Viewport } from './geometry'

const VIEW: Viewport = { width: 1920, height: 1040 }

function pane(): DraftZone[] {
  return [
    {
      id: 'left',
      roleId: 'worker',
      label: 'Worker',
      color: '#2f7d6d',
      rect: { x: 0, y: 0, width: 960, height: 1040 }
    },
    {
      id: 'right',
      roleId: 'reviewer',
      label: 'Reviewer',
      color: '#8c4a3a',
      rect: { x: 960, y: 0, width: 960, height: 1040 }
    }
  ]
}

describe('applyGesture', () => {
  it('moves only the dragged zone when reflow is off', () => {
    const next = { x: 0, y: 0, width: 600, height: 1040 }
    const result = applyGesture(pane(), 'left', next, VIEW, false)
    expect(result.find((zone) => zone.id === 'left')!.rect).toEqual(next)
    expect(result.find((zone) => zone.id === 'right')!.rect).toEqual({
      x: 960,
      y: 0,
      width: 960,
      height: 1040
    })
  })

  it('resizes neighbors when reflow is on', () => {
    const result = applyGesture(
      pane(),
      'left',
      { x: 0, y: 0, width: 600, height: 1040 },
      VIEW,
      true
    )
    expect(result.find((zone) => zone.id === 'left')!.rect).toEqual({
      x: 0,
      y: 0,
      width: 600,
      height: 1040
    })
    expect(result.find((zone) => zone.id === 'right')!.rect).toEqual({
      x: 600,
      y: 0,
      width: 1320,
      height: 1040
    })
  })
})
