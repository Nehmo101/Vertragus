import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRepoFile } from '@main/integrations/githubContents'
import { retroSyncConfig } from '@main/orchestrator/retroSyncConfig'
import {
  getPromptOverlay,
  OVERLAY_MAX_BYTES,
  OVERLAY_MAX_LINES,
  promptOverlayInternals,
  refreshPromptOverlay,
  sanitizeOverlay
} from './promptOverlay'

let userDataDir = '/tmp/orca-overlay-test-unset'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userDataDir) }
}))

vi.mock('@main/integrations/githubContents', () => ({
  getRepoFile: vi.fn(async () => undefined)
}))

vi.mock('@main/orchestrator/retroSyncConfig', () => ({
  retroSyncConfig: vi.fn(() => ({
    enabled: true,
    repoOwner: 'Nehmo101',
    repoName: 'Orca-Strator',
    branch: 'retros'
  }))
}))

describe('sanitizeOverlay', () => {
  it('normalizes newlines, strips control chars and trims', () => {
    expect(sanitizeOverlay('- Regel 1\r\n- Regel 2\r')).toBe('- Regel 1\n- Regel 2')
    expect(sanitizeOverlay('   \n \n')).toBe('')
  })

  it('caps at the line limit', () => {
    const raw = Array.from({ length: OVERLAY_MAX_LINES + 20 }, (_, i) => `- Regel ${i}`).join('\n')
    const lines = sanitizeOverlay(raw).split('\n')
    expect(lines).toHaveLength(OVERLAY_MAX_LINES)
  })

  it('caps at the byte limit on a line boundary', () => {
    const line = `- ${'x'.repeat(500)}`
    const raw = Array.from({ length: 60 }, () => line).join('\n')
    const result = sanitizeOverlay(raw)
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(OVERLAY_MAX_BYTES)
    for (const kept of result.split('\n')) expect(kept).toBe(line)
  })
})

describe('promptOverlay cache', () => {
  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-overlay-'))
    promptOverlayInternals.reset()
    vi.mocked(getRepoFile).mockReset().mockResolvedValue(undefined)
    vi.mocked(retroSyncConfig).mockReset().mockReturnValue({
      enabled: true,
      repoOwner: 'Nehmo101',
      repoName: 'Orca-Strator',
      branch: 'retros'
    })
  })

  it('returns undefined while retro sync is disabled', () => {
    vi.mocked(retroSyncConfig).mockReturnValue({
      enabled: false,
      repoOwner: 'o',
      repoName: 'r',
      branch: 'retros'
    })
    expect(getPromptOverlay()).toBeUndefined()
    expect(getRepoFile).not.toHaveBeenCalled()
  })

  it('serves the fetched overlay synchronously after a refresh', async () => {
    vi.mocked(getRepoFile).mockResolvedValue({
      content: '- Bevorzuge kleine Pläne\n- Review-Tasks an präzise Modelle',
      sha: 'abc',
      size: 60
    })
    await refreshPromptOverlay()
    expect(getPromptOverlay()).toBe('- Bevorzuge kleine Pläne\n- Review-Tasks an präzise Modelle')
  })

  it('keeps the cached overlay when the remote file disappears or errors', async () => {
    vi.mocked(getRepoFile).mockResolvedValue({ content: '- Regel A', sha: 'a', size: 9 })
    await refreshPromptOverlay()
    expect(getPromptOverlay()).toBe('- Regel A')

    vi.mocked(getRepoFile).mockResolvedValue(undefined)
    await refreshPromptOverlay()
    expect(getPromptOverlay()).toBe('- Regel A')

    vi.mocked(getRepoFile).mockRejectedValue(new Error('offline'))
    await refreshPromptOverlay()
    expect(getPromptOverlay()).toBe('- Regel A')
  })

  it('hydrates lazily from the disk cache after a restart', async () => {
    vi.mocked(getRepoFile).mockResolvedValue({ content: '- Persistente Regel', sha: 'p', size: 20 })
    await refreshPromptOverlay()
    // Neustart simulieren: Memory-Cache weg, Disk-Cache bleibt.
    promptOverlayInternals.reset()
    expect(getPromptOverlay()).toBe('- Persistente Regel')
  })
})
