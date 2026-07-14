import { describe, expect, it } from 'vitest'
import {
  CODEX_WINDOWS_SINGLE_ROOT_CONFIG,
  codexSingleRootEnvironment,
  codexSingleRootSandboxArgs
} from './codexSandbox'

describe('Codex Windows single-root sandbox', () => {
  it('excludes the separate slash-tmp root only on native Windows', () => {
    expect(codexSingleRootSandboxArgs('win32')).toEqual([
      '-c',
      CODEX_WINDOWS_SINGLE_ROOT_CONFIG
    ])
    expect(codexSingleRootSandboxArgs('linux')).toEqual([])
    expect(codexSingleRootSandboxArgs('darwin')).toEqual([])
  })

  it('moves every Windows temp variable into the worker runtime directory', () => {
    const base = { PATH: 'C:\\tools', TEMP: 'C:\\outside', TMP: 'C:\\outside' }
    expect(codexSingleRootEnvironment('C:\\repo\\.orca-runtime\\codex-1', base, 'win32')).toEqual({
      ...base,
      TEMP: 'C:\\repo\\.orca-runtime\\codex-1',
      TMP: 'C:\\repo\\.orca-runtime\\codex-1',
      TMPDIR: 'C:\\repo\\.orca-runtime\\codex-1'
    })
    expect(codexSingleRootEnvironment('/repo/.orca-runtime/codex-1', base, 'linux')).toEqual(base)
  })
})
