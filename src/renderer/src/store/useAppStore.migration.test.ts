import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveInitialLayout, uiCommandViewToHash } from '@renderer/store/useAppStore'

describe('resolveInitialLayout — canvas-default one-time migration (D1)', () => {
  it('forces canvas on the first run regardless of the stored layout', () => {
    // Never migrated yet → canvas wins once, and the flag must be persisted.
    expect(resolveInitialLayout(undefined, undefined)).toEqual({ layout: 'canvas', applyCanvasDefault: true })
    expect(resolveInitialLayout('tiles', undefined)).toEqual({ layout: 'canvas', applyCanvasDefault: true })
    expect(resolveInitialLayout('focus', false)).toEqual({ layout: 'canvas', applyCanvasDefault: true })
  })

  it('respects the stored layout once the migration has been applied', () => {
    expect(resolveInitialLayout('tiles', true)).toEqual({ layout: 'tiles', applyCanvasDefault: false })
    expect(resolveInitialLayout('focus', true)).toEqual({ layout: 'focus', applyCanvasDefault: false })
    expect(resolveInitialLayout('canvas', true)).toEqual({ layout: 'canvas', applyCanvasDefault: false })
  })

  it('does not re-migrate: a user who later picks tiles keeps tiles', () => {
    const afterMigration = resolveInitialLayout('canvas', undefined)
    expect(afterMigration.applyCanvasDefault).toBe(true)
    // Next launch: flag is now set, user has switched to tiles.
    expect(resolveInitialLayout('tiles', true)).toEqual({ layout: 'tiles', applyCanvasDefault: false })
  })

  it('folds the legacy dag layout onto canvas and unknown values onto tiles', () => {
    expect(resolveInitialLayout('dag', true)).toEqual({ layout: 'canvas', applyCanvasDefault: false })
    expect(resolveInitialLayout('bogus', true)).toEqual({ layout: 'tiles', applyCanvasDefault: false })
    expect(resolveInitialLayout(null, true)).toEqual({ layout: 'tiles', applyCanvasDefault: false })
  })

  it('persists the migration flag via ui.canvasDefaultApplied in init()', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'useAppStore.ts'), 'utf8')
    expect(source).toMatch(/ui\.canvasDefaultApplied/)
    expect(source).toMatch(/resolveInitialLayout\s*\(/)
    expect(source).toMatch(/setConfig\(\s*['"]ui\.canvasDefaultApplied['"]\s*,\s*true\s*\)/)
  })
})

describe('uiCommandViewToHash', () => {
  it('maps known navigation targets to their hash route', () => {
    expect(uiCommandViewToHash('inbox')).toBe('#/inbox')
    expect(uiCommandViewToHash('remote')).toBe('#/remote')
    expect(uiCommandViewToHash('approvals')).toBe('#/approvals')
    expect(uiCommandViewToHash('changes')).toBe('#/changes')
    expect(uiCommandViewToHash('canvas')).toBe('#/')
  })

  it('is case/whitespace tolerant and defaults unknown views to the workspace', () => {
    expect(uiCommandViewToHash('  INBOX ')).toBe('#/inbox')
    expect(uiCommandViewToHash('mission')).toBe('#/remote')
    expect(uiCommandViewToHash('something-else')).toBe('#/')
    expect(uiCommandViewToHash(undefined)).toBe('#/')
  })
})
