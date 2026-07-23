import { describe, expect, it, vi } from 'vitest'
import type {
  RendererIpcEventLike,
  RendererIpcWebContentsLike
} from '@main/security/ipcAuthorization'
import {
  ATTENTION_COUNT_MAX,
  createAttentionIpcController,
  parsePendingFeedbackCount,
  type AttentionIpcDependencies
} from './attentionIpc'

function event(
  id = 7,
  url = 'http://localhost:5173/#/',
  destroyed = false
): RendererIpcEventLike {
  const frame = { url }
  const sender: RendererIpcWebContentsLike = {
    id,
    isDestroyed: () => destroyed,
    getURL: () => url,
    mainFrame: frame
  }
  return { sender, senderFrame: frame }
}

function dependencies(
  setPendingFeedbackCount = vi.fn()
): AttentionIpcDependencies {
  return {
    authorization: {
      developmentUrl: 'http://localhost:5173',
      packagedRendererUrl: 'file:///app/renderer/index.html',
      isKnownSender: (sender) => sender.id === 7
    },
    setPendingFeedbackCount
  }
}

describe('parsePendingFeedbackCount', () => {
  it('accepts integers in range and clamps to [0, 10000]', () => {
    expect(parsePendingFeedbackCount(0)).toBe(0)
    expect(parsePendingFeedbackCount(3)).toBe(3)
    expect(parsePendingFeedbackCount(-1)).toBe(0)
    expect(parsePendingFeedbackCount(ATTENTION_COUNT_MAX + 1)).toBe(ATTENTION_COUNT_MAX)
  })

  it('rejects non-finite, non-integer and non-number payloads (validation negative)', () => {
    for (const invalid of [NaN, Infinity, -Infinity, 1.5, '3', null, undefined, {}, true]) {
      expect(() => parsePendingFeedbackCount(invalid)).toThrow(/invalid payload/i)
    }
  })
})

describe('attention IPC authorization', () => {
  it('allows an authorized main-window count update', () => {
    const deps = dependencies()
    const controller = createAttentionIpcController(deps)

    controller.setPendingFeedbackCount(event(), 4)
    expect(deps.setPendingFeedbackCount).toHaveBeenCalledOnce()
    expect(deps.setPendingFeedbackCount).toHaveBeenCalledWith(4)
  })

  it('rejects unauthorized senders before mutating attention state (auth negative)', () => {
    const deps = dependencies()
    const controller = createAttentionIpcController(deps)
    const unknownWindow = event(8)
    const foreignOrigin = event(7, 'https://attacker.example')
    const subframe = event()
    subframe.senderFrame = { url: 'http://localhost:5173/embedded' }
    const missingFrame = event()
    missingFrame.senderFrame = null
    const destroyedSender = event(7, 'http://localhost:5173/#/', true)

    for (const invalidContext of [
      unknownWindow,
      foreignOrigin,
      subframe,
      missingFrame,
      destroyedSender
    ]) {
      expect(() => controller.setPendingFeedbackCount(invalidContext, 2)).toThrow(
        /Zugriff verweigert|unauthorized/i
      )
    }
    expect(deps.setPendingFeedbackCount).not.toHaveBeenCalled()
  })

  it('authorizes before validation and rejects an invalid payload before mutation', () => {
    const deps = dependencies()
    const controller = createAttentionIpcController(deps)

    expect(() => controller.setPendingFeedbackCount(event(8), NaN)).toThrow(/unauthorized/i)
    expect(() => controller.setPendingFeedbackCount(event(), NaN)).toThrow(/invalid payload/i)
    expect(() => controller.setPendingFeedbackCount(event(), 1.25)).toThrow(/invalid payload/i)
    expect(() => controller.setPendingFeedbackCount(event(), '9')).toThrow(/invalid payload/i)
    expect(deps.setPendingFeedbackCount).not.toHaveBeenCalled()
  })

  it('rejects without leaking renderer context or the raw count', () => {
    const controller = createAttentionIpcController(dependencies())
    let rejection: unknown

    try {
      controller.setPendingFeedbackCount(event(7, 'https://attacker.example/private'), 42)
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).not.toContain('attacker.example')
    expect((rejection as Error).message).not.toContain('42')
  })
})
