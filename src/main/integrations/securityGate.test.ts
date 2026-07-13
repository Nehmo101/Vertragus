import { describe, expect, it } from 'vitest'
import { assertSecurityGate, evaluateSecurityGate, securityChecklistForFiles } from './securityGate'

function diffFile(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    ...lines.map((line) => `+${line}`)
  ].join('\n')
}

describe('security gate', () => {
  it('allows ordinary source changes without security-test ceremony', () => {
    const report = assertSecurityGate(diffFile('src/main/math.ts', ['export const sum = 1 + 1']))
    expect(report.detectedSurfaces).toEqual([])
    expect(report.findings).toEqual([])
  })

  it('blocks leaked credentials in added lines', () => {
    const leakedToken = `ghp_${'a'.repeat(32)}`
    expect(() =>
      assertSecurityGate(diffFile('src/main/config.ts', [`const token = "${leakedToken}"`]))
    ).toThrow(/Secret/i)
  })

  it('requires authorization and validation negatives for a new IPC path', () => {
    const report = evaluateSecurityGate(
      diffFile('src/main/ipc/accounts.ts', [
        "ipcMain.handle('account:read', (_event, id) => readAccount(id))"
      ])
    )
    expect(report.findings).toEqual([
      expect.objectContaining({
        surface: 'ipc',
        missingControls: ['authorization', 'validation']
      })
    ])
    expect(() => assertSecurityGate(diffFile('src/main/ipc/accounts.ts', ['ipcMain.handle()']))).toThrow(
      /Negativtests/
    )
  })

  it('accepts IPC changes with explicit authorization and validation negative tests', () => {
    const diff = [
      diffFile('src/main/ipc/accounts.ts', [
        "ipcMain.handle('account:read', (_event, id) => readAccount(id))"
      ]),
      diffFile('src/main/ipc/accounts.test.ts', [
        "it('rejects an unauthorized caller', async () => {",
        "  await expect(callAsGuest()).rejects.toThrow('forbidden')",
        '})',
        "it('rejects an invalid id', async () => {",
        "  await expect(call('')).rejects.toThrow('invalid')",
        '})'
      ])
    ].join('\n')
    expect(assertSecurityGate(diff).findings).toEqual([])
  })

  it('requires traversal coverage for new filesystem access', () => {
    const source = diffFile('src/main/files/read.ts', [
      "import { readFile } from 'node:fs/promises'",
      'export const read = (path: string) => readFile(path)'
    ])
    const validationOnly = diffFile('src/main/files/read.test.ts', [
      "it('rejects an invalid empty path', () => expect(read('')).rejects.toThrow())"
    ])
    expect(() => assertSecurityGate(`${source}\n${validationOnly}`)).toThrow(/path-traversal/)

    const traversalTest = diffFile('src/main/files/read.test.ts', [
      "it('blocks path traversal outside root', () => expect(read('../secret')).rejects.toThrow())"
    ])
    expect(assertSecurityGate(`${source}\n${traversalTest}`).findings).toEqual([])
  })

  it('requires redaction coverage for OAuth and secret-handling paths', () => {
    const source = diffFile('src/main/auth/oauth.ts', [
      'export async function exchangeOauthCode(code: string, clientSecret: string) {}'
    ])
    const tests = diffFile('src/main/auth/oauth.test.ts', [
      "it('rejects an unauthorized invalid state', () => expect(exchange('bad')).rejects.toThrow())",
      "it('does not leak secrets', async () => expect(await failure()).not.toContain('client-secret'))"
    ])
    expect(assertSecurityGate(`${source}\n${tests}`).findings).toEqual([])
  })


  it('derives task DoD checks from expected security-sensitive files', () => {
    expect(securityChecklistForFiles([
      'src/main/ipc/accounts.ts',
      'src/main/auth/oauth.ts',
      'src/main/files/workspacePath.ts'
    ])).toEqual(expect.arrayContaining([
      expect.stringMatching(/Autorisierungs-Negativtest/),
      expect.stringMatching(/Validierungs-Negativtest/),
      expect.stringMatching(/Path-Traversal/),
      expect.stringMatching(/Secret-Leak/)
    ]))
    expect(securityChecklistForFiles(['src/renderer/math.ts'])).toEqual([])
  })
})
