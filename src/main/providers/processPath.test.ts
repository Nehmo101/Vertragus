import { describe, expect, it } from 'vitest'
import {
  darwinLoginShellExecutable,
  darwinLoginShellPath,
  darwinProcessPath,
  mergePathValues
} from '@main/providers/processPath'

describe('mergePathValues', () => {
  it('keeps inherited entries and adds newly installed Windows paths', () => {
    expect(
      mergePathValues(
        ';',
        'C:\\Orca\\bin;C:\\Windows\\System32',
        'C:\\Windows\\System32;C:\\Program Files (x86)\\cloudflared\\',
        'C:\\Users\\test\\bin'
      )
    ).toBe(
      'C:\\Orca\\bin;C:\\Windows\\System32;C:\\Program Files (x86)\\cloudflared\\;C:\\Users\\test\\bin'
    )
  })

  it('deduplicates case-insensitively and ignores empty entries', () => {
    expect(mergePathValues(';', 'C:\\Tools;;', 'c:\\tools\\; C:\\Other ')).toBe(
      'C:\\Tools;C:\\Other'
    )
  })

  it('keeps distinct case-sensitive POSIX paths while removing exact duplicates', () => {
    expect(mergePathValues(':', '/usr/local/bin:/opt/Tools', '/usr/local/bin/:/opt/tools')).toBe(
      '/usr/local/bin:/opt/Tools:/opt/tools'
    )
  })
})

describe('darwinLoginShellPath', () => {
  it('extracts the marked PATH despite noisy interactive shell startup output', () => {
    expect(
      darwinLoginShellPath(
        'welcome from .zshrc\n__ORCA_LOGIN_SHELL_PATH__=/opt/homebrew/bin:/usr/bin\n'
      )
    ).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('does not treat unrelated shell output as PATH', () => {
    expect(darwinLoginShellPath('welcome\n/usr/local/bin\n')).toBeUndefined()
  })
})

describe('darwin PATH security', () => {
  it('does not interpolate or execute a shell value injected through the environment', () => {
    const executable = darwinLoginShellExecutable('/bin/zsh; touch /tmp/orca-shell-injection')

    expect(executable).toBe('/bin/zsh')
    expect(executable).not.toContain('touch')
    expect(darwinLoginShellExecutable('/bin/bash')).toBe('/bin/bash')
  })

  it('rejects relative, temporary and path traversal entries outside trusted PATH roots', () => {
    const value = darwinProcessPath(
      '/Applications/Orca/bin:/usr/bin',
      '/tmp/attacker:relative/bin:/Users/test/../escape:/Users/test/.local/bin'
    )

    expect(value).toBe(
      '/usr/bin:/bin:/usr/sbin:/sbin:/Applications/Orca/bin:/opt/homebrew/bin:/usr/local/bin:/Users/test/.local/bin'
    )
    expect(value).not.toContain('/tmp/attacker')
    expect(value).not.toContain('relative/bin')
    expect(value).not.toContain('/Users/test/../escape')
  })

  it('uses deterministic Homebrew fallbacks when login-shell discovery fails', () => {
    expect(darwinProcessPath('/usr/bin', undefined)).toBe(
      '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin'
    )
  })
})
