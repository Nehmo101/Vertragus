/**
 * Source-contract test for ClaudePermissionModeSelect — runs in the plain node
 * vitest environment (no DOM, no testing-library). The component is invoked as
 * a pure function and its returned element tree is inspected via props; that is
 * only safe because `react-i18next` is mocked below, so no real React hook runs
 * outside a renderer. The mock's `t` returns `defaultValue ?? key`, mirroring
 * i18next fallback semantics; the locale JSONs are asserted separately so the
 * mock cannot hide missing translation keys.
 */
import { Children, type ChangeEvent, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_PERMISSION_MODE_LABELS, CLAUDE_PERMISSION_MODES } from '@shared/claudePermissionMode'
import de from '@renderer/locales/de.json'
import en from '@renderer/locales/en.json'
import ClaudePermissionModeSelect from './ClaudePermissionModeSelect'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key
  })
}))

function renderSelect(
  overrides: Partial<Parameters<typeof ClaudePermissionModeSelect>[0]> = {}
): ReactElement {
  return ClaudePermissionModeSelect({
    value: 'default',
    onChange: vi.fn(),
    ...overrides
  })
}

describe('ClaudePermissionModeSelect', () => {
  it('renders all three modes with their labels', () => {
    const options = Children.toArray(renderSelect().props.children) as ReactElement[]

    expect(options).toHaveLength(3)
    expect(options.map((option) => option.props.value)).toEqual([...CLAUDE_PERMISSION_MODES])
    expect(options.map((option) => option.props.children)).toEqual(
      CLAUDE_PERMISSION_MODES.map((mode) => CLAUDE_PERMISSION_MODE_LABELS[mode])
    )
  })

  it('reflects the controlled Auto-Mode value', () => {
    expect(renderSelect({ value: 'auto' }).props.value).toBe('auto')
  })

  it('fires onChange with the typed mode', () => {
    const onChange = vi.fn()
    const select = renderSelect({ onChange })

    select.props.onChange({ target: { value: 'auto' } } as ChangeEvent<HTMLSelectElement>)

    expect(onChange).toHaveBeenCalledWith('auto')
  })

  it('supports an id and the disabled state', () => {
    const select = renderSelect({ id: 'permission-mode', disabled: true })

    expect(select.props.id).toBe('permission-mode')
    expect(select.props['aria-label']).toBe('ui.claudePermission.aria')
    expect(select.props.disabled).toBe(true)
  })

  it('backs every t()-key with real DE/EN locale entries', () => {
    for (const locale of [de, en] as const) {
      const claudePermission = (locale as { ui: { claudePermission: Record<string, unknown> } }).ui
        .claudePermission
      expect(String(claudePermission.aria).trim().length).toBeGreaterThan(0)
      const modes = claudePermission.mode as Record<string, string>
      for (const mode of CLAUDE_PERMISSION_MODES) {
        expect(String(modes[mode]).trim().length, `mode.${mode}`).toBeGreaterThan(0)
      }
    }
    // The German aria label stays the one the original TSX test pinned.
    expect(de.ui.claudePermission.aria).toBe('Claude-Berechtigungsmodus')
  })
})
