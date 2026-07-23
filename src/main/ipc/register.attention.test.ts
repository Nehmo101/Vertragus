import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Source-contract regressions for attention IPC wiring in register.ts.
 * Behavioral auth/validation negatives live in attentionIpc.test.ts.
 */
const registerSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'register.ts'), 'utf8')
const preloadSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../preload/index.ts'),
  'utf8'
)

function attentionHandlerBlock(): string {
  const match = registerSrc.match(
    /ipcMain\.on\(\s*IPC\.attentionSetPendingFeedbackCount\s*,[\s\S]*?\n {2}\}\)/
  )
  expect(match, 'expected IPC.attentionSetPendingFeedbackCount on-handler').toBeTruthy()
  return match![0]
}

describe('register.ts attention IPC wiring', () => {
  it('registers a one-way on-handler (not invoke) for attention:setPendingFeedbackCount', () => {
    const block = attentionHandlerBlock()
    expect(block).toMatch(/^ipcMain\.on\s*\(/)
    expect(registerSrc).not.toMatch(
      /ipcMain\.handle\s*\(\s*IPC\.attentionSetPendingFeedbackCount/
    )
    expect(block).toMatch(/attentionController\.setPendingFeedbackCount/)
    expect(block).toMatch(/catch/)
  })

  it('wires attention through createAttentionIpcController + rendererAuthorization', () => {
    expect(registerSrc).toMatch(/createAttentionIpcController\s*\(/)
    expect(registerSrc).toMatch(
      /createAttentionIpcController\(\{[\s\S]*authorization:\s*rendererAuthorization/
    )
  })

  it('preload exposes one-way send under window.vertragus.attention', () => {
    expect(preloadSrc).toMatch(/attention:\s*\{/)
    expect(preloadSrc).toMatch(
      /setPendingFeedbackCount:\s*\(count\)\s*=>\s*ipcRenderer\.send\(\s*IPC\.attentionSetPendingFeedbackCount/
    )
    expect(preloadSrc).not.toMatch(
      /attentionSetPendingFeedbackCount[\s\S]{0,40}ipcRenderer\.invoke/
    )
  })
})
