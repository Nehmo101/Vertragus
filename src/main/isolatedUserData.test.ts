import { app } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { applyIsolatedUserData, USER_DATA_ENV } from './isolatedUserData'

vi.mock('electron', () => ({
  app: { setPath: vi.fn() }
}))

describe('applyIsolatedUserData', () => {
  it('does nothing without VERTRAGUS_USER_DATA', () => {
    const setPath = vi.fn()
    expect(applyIsolatedUserData({}, setPath)).toBeUndefined()
    expect(setPath).not.toHaveBeenCalled()
  })

  it('points userData and sessionData at the given directory', () => {
    const setPath = vi.fn()
    expect(applyIsolatedUserData({ [USER_DATA_ENV]: ' /tmp/vertragus-smoke ' }, setPath)).toBe(
      '/tmp/vertragus-smoke'
    )
    expect(setPath).toHaveBeenCalledWith('userData', '/tmp/vertragus-smoke')
    expect(setPath).toHaveBeenCalledWith('sessionData', '/tmp/vertragus-smoke')
  })

  it('ignores a blank value', () => {
    const setPath = vi.fn()
    expect(applyIsolatedUserData({ [USER_DATA_ENV]: '  ' }, setPath)).toBeUndefined()
    expect(setPath).not.toHaveBeenCalled()
  })

  it('defaults to Electron app.setPath', () => {
    expect(applyIsolatedUserData({ [USER_DATA_ENV]: 'D:\\iso' })).toBe('D:\\iso')
    expect(app.setPath).toHaveBeenCalledWith('userData', 'D:\\iso')
    expect(app.setPath).toHaveBeenCalledWith('sessionData', 'D:\\iso')
  })
})
