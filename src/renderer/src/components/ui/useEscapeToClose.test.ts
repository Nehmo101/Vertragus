import { describe, expect, it, vi } from 'vitest'
import { createEscapeKeydownHandler } from './useEscapeToClose'

describe('createEscapeKeydownHandler', () => {
  it('calls onClose on Escape', () => {
    const onClose = vi.fn()
    const handler = createEscapeKeydownHandler(onClose)

    handler({ key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores other keys', () => {
    const onClose = vi.fn()
    const handler = createEscapeKeydownHandler(onClose)

    handler({ key: 'Enter' })
    handler({ key: 'Esc' })
    handler({ key: 'Tab' })

    expect(onClose).not.toHaveBeenCalled()
  })
})
