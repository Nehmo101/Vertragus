import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE } from '@shared/profile'
import type {
  RendererIpcEventLike,
  RendererIpcWebContentsLike
} from '@main/security/ipcAuthorization'
import {
  createProfileDeletionIpcController,
  type ProfileDeletionIpcDependencies
} from './profileDeletionIpc'

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
  deleteProfile = vi.fn(() => [DEFAULT_PROFILE])
): ProfileDeletionIpcDependencies {
  return {
    authorization: {
      developmentUrl: 'http://localhost:5173',
      packagedRendererUrl: 'file:///app/renderer/index.html',
      isKnownSender: (sender) => sender.id === 7
    },
    deleteProfile
  }
}

describe('profile deletion IPC authorization', () => {
  it('allows an authorized main-window deletion request', () => {
    const deps = dependencies()
    const controller = createProfileDeletionIpcController(deps)

    expect(controller.delete(event(), 'custom')).toEqual([DEFAULT_PROFILE])
    expect(deps.deleteProfile).toHaveBeenCalledOnce()
    expect(deps.deleteProfile).toHaveBeenCalledWith('custom')
  })

  it('rejects unauthorized senders and invalid frame contexts before every mutation', () => {
    const deps = dependencies()
    const controller = createProfileDeletionIpcController(deps)
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
      expect(() => controller.delete(invalidContext, 'custom')).toThrow(
        /Zugriff verweigert|unauthorized/i
      )
    }
    expect(deps.deleteProfile).not.toHaveBeenCalled()
  })

  it('authorizes before validation and rejects an invalid payload before mutation', () => {
    const deps = dependencies()
    const controller = createProfileDeletionIpcController(deps)

    expect(() => controller.delete(event(8), null)).toThrow(/unauthorized/i)
    expect(() => controller.delete(event(), null)).toThrow(/ungültig|invalid/i)
    expect(() => controller.delete(event(), '')).toThrow(/ungültig|invalid/i)
    expect(deps.deleteProfile).not.toHaveBeenCalled()
  })

  it('rejects without leaking renderer context or the requested profile id', () => {
    const controller = createProfileDeletionIpcController(dependencies())
    let rejection: unknown

    try {
      controller.delete(event(7, 'https://attacker.example/private'), 'sensitive-profile')
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).not.toContain('attacker.example')
    expect((rejection as Error).message).not.toContain('sensitive-profile')
  })
})
