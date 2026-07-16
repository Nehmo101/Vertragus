import { Children, type ChangeEvent, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_PERMISSION_MODE_LABELS, CLAUDE_PERMISSION_MODES } from '@shared/claudePermissionMode'
import ClaudePermissionModeSelect from './ClaudePermissionModeSelect'

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
    expect(select.props['aria-label']).toBe('Claude-Berechtigungsmodus')
    expect(select.props.disabled).toBe(true)
  })
})
