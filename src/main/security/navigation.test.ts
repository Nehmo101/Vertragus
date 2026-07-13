import { describe, expect, it, vi } from 'vitest'
import { isAllowedExternalUrl, isTrustedRendererUrl, protectWebContents } from './navigation'

describe('desktop navigation policy', () => {
  it('only allows explicit external schemes', () => {
    expect(isAllowedExternalUrl('https://github.com/Nehmo101/Orca-Strator')).toBe(true)
    expect(isAllowedExternalUrl('mailto:security@example.com')).toBe(true)
    expect(isAllowedExternalUrl('http://example.com')).toBe(false)
    expect(isAllowedExternalUrl('file:///C:/Users/example/secret.txt')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('not a url')).toBe(false)
  })

  it('trusts packaged files and only the configured development origin', () => {
    const packaged = 'file:///C:/app/out/renderer/index.html'
    expect(isTrustedRendererUrl(packaged, undefined, packaged)).toBe(true)
    expect(isTrustedRendererUrl('file:///C:/evil/renderer/index.html', undefined, packaged)).toBe(false)
    expect(isTrustedRendererUrl('file:///C:/Users/example/secret.html', undefined, packaged)).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:5173/#/pane/a', 'http://localhost:5173')).toBe(true)
    expect(isTrustedRendererUrl('http://localhost.evil.test:5173', 'http://localhost:5173')).toBe(false)
    expect(isTrustedRendererUrl('https://example.com')).toBe(false)
  })

  it('blocks popups and forwards only allowed URLs to the system browser', () => {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    let openHandler: ((details: { url: string }) => { action: string }) | undefined
    const webContents = {
      setWindowOpenHandler: vi.fn((handler) => {
        openHandler = handler
      }),
      on: vi.fn((name, handler) => handlers.set(name, handler))
    }
    const openExternal = vi.fn(async () => undefined)

    protectWebContents(webContents as never, {
      developmentUrl: 'http://localhost:5173',
      packagedRendererUrl: 'file:///C:/app/out/renderer/index.html',
      openExternal
    })

    expect(openHandler?.({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(openHandler?.({ url: 'file:///C:/secret.txt' })).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledOnce()

    const preventDefault = vi.fn()
    handlers.get('will-navigate')?.({ preventDefault }, 'https://example.com')
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledTimes(2)

    const trustedPreventDefault = vi.fn()
    handlers.get('will-navigate')?.({ preventDefault: trustedPreventDefault }, 'http://localhost:5173/#/pane/a')
    expect(trustedPreventDefault).not.toHaveBeenCalled()
  })
})
