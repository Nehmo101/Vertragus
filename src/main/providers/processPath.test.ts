/**
 * The PATH repair path is security-relevant, which is why it is tested at all.
 *
 * Two of its rules exist purely to keep an attacker out of a process that
 * spawns provider CLIs: `$SHELL` is inherited environment and must never be
 * executed unless it is one of the system shells, and a login shell's PATH is
 * written by dotfiles, so world-writable roots (`/tmp`, `/var/tmp`) cannot be
 * allowed to contribute an entry this process would then run. Both refusals
 * are silent by design — nothing downstream would notice if they regressed, so
 * the cases below are the only place they are stated.
 */
import { describe, expect, it } from 'vitest'
import {
  darwinLoginShellExecutable,
  darwinLoginShellPath,
  darwinProcessPath,
  mergePathValues,
  safeDarwinDiscoveredPath
} from './processPath'

const MARKER = '__VERTRAGUS_LOGIN_SHELL_PATH__='

describe('darwinLoginShellPath', () => {
  it('reads only the marked line, not the shell startup chatter around it', () => {
    const stdout = [
      'Last login: Tue Aug 12 09:31:02',
      'nvm: no .nvmrc found',
      `${MARKER}/opt/homebrew/bin:/usr/bin:/bin`,
      ''
    ].join('\n')
    expect(darwinLoginShellPath(stdout)).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  /**
   * A `.zshrc` can print anything, including a line that looks like the marker.
   * The real value is the LAST one, because the probe's own printf runs after
   * every startup file — so a spoofed line earlier in the stream loses.
   */
  it('takes the last marker so a dotfile cannot spoof the answer', () => {
    const stdout = [
      `${MARKER}/tmp/attacker`,
      'echo from .zprofile',
      `${MARKER}/opt/homebrew/bin`
    ].join('\n')
    expect(darwinLoginShellPath(stdout)).toBe('/opt/homebrew/bin')
  })

  it('tolerates CRLF and trailing whitespace around the value', () => {
    expect(darwinLoginShellPath(`noise\r\n${MARKER}/usr/local/bin  \r\n`)).toBe('/usr/local/bin')
  })

  it('answers undefined when the shell never reached the printf', () => {
    expect(darwinLoginShellPath('zsh: permission denied\n')).toBeUndefined()
    expect(darwinLoginShellPath('')).toBeUndefined()
  })
})

describe('darwinLoginShellExecutable', () => {
  it.each(['/bin/zsh', '/bin/bash', '/bin/sh'])('runs the system shell %s as configured', (shell) => {
    expect(darwinLoginShellExecutable(shell)).toBe(shell)
  })

  it('trims the inherited value before deciding', () => {
    expect(darwinLoginShellExecutable('  /bin/bash  ')).toBe('/bin/bash')
  })

  /**
   * `$SHELL` is inherited environment — a compromised parent process or a
   * planted launch agent sets it for free. Anything outside the system shells
   * is refused rather than executed, so this cannot become an arbitrary-code
   * path that the app itself opens on every failed probe.
   */
  it.each([
    '/tmp/evil.sh',
    '/Users/tester/.local/bin/zsh',
    '/opt/homebrew/bin/fish',
    '/bin/zsh; rm -rf ~',
    ''
  ])('refuses %j and falls back to /bin/zsh', (shell) => {
    expect(darwinLoginShellExecutable(shell)).toBe('/bin/zsh')
  })

  it('falls back when nothing is configured at all', () => {
    expect(darwinLoginShellExecutable(undefined)).toBe('/bin/zsh')
  })
})

describe('safeDarwinDiscoveredPath', () => {
  it('keeps the ordinary install locations a login shell adds', () => {
    expect(safeDarwinDiscoveredPath('/opt/homebrew/bin:/Users/t/.local/bin:/usr/local/bin')).toBe(
      '/opt/homebrew/bin:/Users/t/.local/bin:/usr/local/bin'
    )
  })

  /**
   * Every one of these roots is world-writable. An entry there means anyone
   * with a local foothold can drop a `claude` binary that the health probe
   * then executes — so a dotfile's PATH cannot contribute one.
   */
  it.each([
    '/tmp',
    '/tmp/bin',
    '/private/tmp/bin',
    '/var/tmp',
    '/private/var/tmp/x/bin',
    '/tmp/'
  ])('drops the world-writable entry %s', (entry) => {
    expect(safeDarwinDiscoveredPath(`/usr/bin:${entry}:/opt/homebrew/bin`)).toBe(
      '/usr/bin:/opt/homebrew/bin'
    )
  })

  /** A traversal is how `/opt/../tmp/bin` would sneak past a prefix check. */
  it('drops relative and traversing entries instead of normalizing them', () => {
    expect(safeDarwinDiscoveredPath('bin:./bin:../bin:/opt/../tmp/bin:/opt/homebrew/bin')).toBe(
      '/opt/homebrew/bin'
    )
  })

  it('trims whitespace and trailing separators, and survives an empty PATH', () => {
    expect(safeDarwinDiscoveredPath(' /opt/homebrew/bin/ ::/usr/bin ')).toBe(
      '/opt/homebrew/bin:/usr/bin'
    )
    expect(safeDarwinDiscoveredPath(undefined)).toBe('')
    expect(safeDarwinDiscoveredPath('')).toBe('')
  })

  /** `/var/tmpfiles` is not under `/var/tmp`; only a real path segment counts. */
  it('does not reject a directory that merely starts with an unsafe name', () => {
    expect(safeDarwinDiscoveredPath('/var/tmpfiles/bin')).toBe('/var/tmpfiles/bin')
  })
})

describe('darwinProcessPath', () => {
  it('keeps the OS directories ahead of everything discovered or inherited', () => {
    const merged = darwinProcessPath('/Applications/Vertragus.app/Contents/MacOS', '/sw/bin')
    expect(merged.split(':').slice(0, 4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin'])
    expect(merged.split(':')).toContain('/Applications/Vertragus.app/Contents/MacOS')
    expect(merged.split(':')).toContain('/sw/bin')
  })

  /** Without a readable login shell the Homebrew locations must still be tried. */
  it('adds the deterministic Homebrew fallback when the shell answered nothing', () => {
    const merged = darwinProcessPath('/usr/bin:/bin:/usr/sbin:/sbin', undefined)
    expect(merged).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin')
  })

  it('filters the discovered value through the world-writable refusal', () => {
    expect(darwinProcessPath(undefined, '/tmp/bin:/sw/bin').split(':')).not.toContain('/tmp/bin')
  })

  it('never lists the same directory twice', () => {
    const entries = darwinProcessPath('/opt/homebrew/bin', '/opt/homebrew/bin/:/usr/bin').split(':')
    expect(entries.filter((entry) => entry === '/opt/homebrew/bin')).toHaveLength(1)
  })
})

describe('mergePathValues', () => {
  it('keeps the first spelling and the first position of each directory', () => {
    expect(mergePathValues(':', '/usr/bin:/bin', '/bin:/opt/homebrew/bin')).toBe(
      '/usr/bin:/bin:/opt/homebrew/bin'
    )
  })

  it('treats a trailing separator as the same directory', () => {
    expect(mergePathValues(':', '/usr/bin/', '/usr/bin')).toBe('/usr/bin/')
  })

  /** Windows PATH comparison is case-insensitive; POSIX is not. */
  it('deduplicates case-insensitively for Windows and case-sensitively for POSIX', () => {
    expect(mergePathValues(';', 'C:\\Windows\\System32', 'c:\\windows\\system32')).toBe(
      'C:\\Windows\\System32'
    )
    expect(mergePathValues(':', '/usr/bin', '/USR/BIN')).toBe('/usr/bin:/USR/BIN')
  })

  it('skips undefined values and empty segments', () => {
    expect(mergePathValues(':', undefined, '/usr/bin::  :/bin', '')).toBe('/usr/bin:/bin')
  })
})
