import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IPC } from '@shared/ipc'
import {
  buildVertragusApi,
  ipcManifest,
  listIpcChannels,
  type CustomBridgeBindings,
  type IpcTransport
} from '@shared/ipcManifest'

/**
 * Contract regressions for attention IPC wiring (manifest edition).
 * Behavioral auth/validation negatives live in attentionIpc.test.ts.
 */
const registerSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'register.ts'), 'utf8')

describe('attention IPC wiring', () => {
  it('declares a one-way controller-authorized send channel in the manifest', () => {
    const spec = ipcManifest.attentionSetPendingFeedbackCount
    expect(spec.kind).toBe('send')
    expect(spec.auth).toBe('controller')
    expect(spec.validation).toBe('handler')
    expect(spec.channel).toBe(IPC.attentionSetPendingFeedbackCount)
  })

  it('routes through attentionController and drops invalid payloads without a reply', () => {
    const handler = registerSrc.match(
      /attentionSetPendingFeedbackCount:\s*\(e, count\)\s*=>\s*\{[\s\S]*?\n {4}\}/
    )
    expect(handler, 'expected attentionSetPendingFeedbackCount handler in the map').toBeTruthy()
    expect(handler![0]).toMatch(/attentionController\.setPendingFeedbackCount/)
    expect(handler![0]).toMatch(/catch/)
  })

  it('wires attention through createAttentionIpcController + rendererAuthorization', () => {
    expect(registerSrc).toMatch(/createAttentionIpcController\s*\(/)
    expect(registerSrc).toMatch(
      /createAttentionIpcController\(\{[\s\S]*authorization:\s*rendererAuthorization/
    )
  })

  it('bridges window.vertragus.attention.setPendingFeedbackCount as a one-way send', () => {
    const sends: unknown[][] = []
    const transport: IpcTransport = {
      invoke: async () => {
        throw new Error('attention must not invoke')
      },
      send: (channel, ...args) => {
        sends.push([channel, ...args])
      },
      subscribe: () => () => {}
    }
    const custom = Object.fromEntries(
      listIpcChannels()
        .filter((e) => e.spec.bridge === 'custom')
        .map((e) => [e.key, () => undefined])
    ) as unknown as CustomBridgeBindings
    const api = buildVertragusApi(transport, custom)
    api.attention.setPendingFeedbackCount(3)
    expect(sends).toEqual([[IPC.attentionSetPendingFeedbackCount, 3]])
  })
})
