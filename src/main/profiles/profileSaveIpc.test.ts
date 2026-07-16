import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE } from '@shared/profile'
import type {
  RendererIpcEventLike,
  RendererIpcWebContentsLike
} from '@main/security/ipcAuthorization'
import { createProfileSaveIpcController } from './profileSaveIpc'

function event(id = 7, url = 'http://localhost:5173/#/'): RendererIpcEventLike {
  const frame = { url }
  const sender: RendererIpcWebContentsLike = {
    id,
    isDestroyed: () => false,
    getURL: () => url,
    mainFrame: frame
  }
  return { sender, senderFrame: frame }
}

function controller(): ReturnType<typeof createProfileSaveIpcController> {
  return createProfileSaveIpcController({
    authorization: {
      developmentUrl: 'http://localhost:5173',
      packagedRendererUrl: 'file:///app/renderer/index.html',
      isKnownSender: (sender) => sender.id === 7
    }
  })
}

describe('profile save IPC boundary', () => {
  it('accepts an authorized valid profile and applies safe defaults', () => {
    expect(controller().authorizeAndParse(event(), {
      id: 'legacy',
      name: 'Legacy'
    })).toMatchObject({
      id: 'legacy',
      autoGit: { enabled: false, targetBranch: '' }
    })
  })

  it('rejects an unauthorized sender before inspecting a malicious payload', () => {
    const payload = {
      ...DEFAULT_PROFILE,
      autoGit: { enabled: true, targetBranch: 'main\n--force' }
    }
    expect(() => controller().authorizeAndParse(event(99, 'https://attacker.example'), payload))
      .toThrow(/unauthorized/i)
  })

  it('rejects invalid Auto-Git input from an authorized sender', () => {
    expect(() => controller().authorizeAndParse(event(), {
      ...DEFAULT_PROFILE,
      autoGit: { enabled: true, targetBranch: '--force' }
    })).toThrow(/Ziel-Branch|ungültig/i)
  })
})
