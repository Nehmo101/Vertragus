import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteStatus } from '@shared/remote'
import {
  HEADLESS_CONTROL_FILENAME,
  formatHeadlessStatusLine,
  headlessStartupLines,
  isHeadlessMode,
  startHeadlessControl,
  type HeadlessControlHandle
} from './headlessMode'
import {
  candidateUserDataDirs,
  formatPairingReport,
  formatStatusReport,
  parseControlAnnouncement,
  parseHeadlessCliArgs
} from '../../scripts/headless.mjs'

describe('headless mode', () => {
  it('activates on VERTRAGUS_HEADLESS=1/true and the ORCA_* legacy alias', () => {
    expect(isHeadlessMode({ VERTRAGUS_HEADLESS: '1' })).toBe(true)
    expect(isHeadlessMode({ VERTRAGUS_HEADLESS: 'true' })).toBe(true)
    expect(isHeadlessMode({ ORCA_HEADLESS: '1' })).toBe(true)
    expect(isHeadlessMode({ VERTRAGUS_HEADLESS: '0' })).toBe(false)
    expect(isHeadlessMode({})).toBe(false)
  })

  it('warns loudly when the host would be unreachable without Mission Control', () => {
    expect(headlessStartupLines(true).join('\n')).toContain('Mission-Control-Gateway')
    const warned = headlessStartupLines(false).join('\n')
    expect(warned).toContain('WARNUNG')
    expect(warned).toContain('nicht fernsteuerbar')
  })
})

describe('formatHeadlessStatusLine', () => {
  const base: RemoteStatus = {
    enabled: true,
    gatewayRunning: true,
    gatewayPort: 4711,
    tunnel: 'online',
    publicUrl: 'https://example.trycloudflare.com',
    deviceCount: 2
  }

  it('emits one parseable line with gateway, tunnel, url and device count', () => {
    expect(formatHeadlessStatusLine(base)).toBe(
      '[headless] gateway=127.0.0.1:4711 tunnel=online url=https://example.trycloudflare.com devices=2'
    )
  })

  it('marks a stopped gateway, omits missing url and appends quoted errors', () => {
    const line = formatHeadlessStatusLine({
      enabled: false,
      gatewayRunning: false,
      tunnel: 'disabled',
      deviceCount: 0,
      error: 'cloudflared beendet (1).'
    })
    expect(line).toBe('[headless] gateway=aus tunnel=disabled devices=0 error="cloudflared beendet (1)."')
  })
})

describe('startHeadlessControl', () => {
  const status: RemoteStatus = {
    enabled: true,
    gatewayRunning: true,
    gatewayPort: 4711,
    tunnel: 'online',
    publicUrl: 'https://example.trycloudflare.com',
    deviceCount: 1
  }
  let dir: string
  let handle: HeadlessControlHandle | undefined

  afterEach(async () => {
    await handle?.close()
    handle = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  async function start(overrides: {
    startPairing?: () => Promise<{ code: string; expiresAt: number; pairingUrl?: string }>
    quit?: () => void
  } = {}): Promise<{ handle: HeadlessControlHandle; token: string }> {
    dir = mkdtempSync(join(tmpdir(), 'vertragus-headless-test-'))
    handle = await startHeadlessControl({
      userDataDir: dir,
      token: 'test-token-1234567890',
      quit: overrides.quit ?? ((): void => undefined),
      remote: {
        status: () => status,
        startPairing:
          overrides.startPairing ??
          (async () => ({
            code: 'abc123',
            expiresAt: 1_700_000_000_000,
            pairingUrl: 'https://example.trycloudflare.com/#/pair?code=abc123',
            qrDataUrl: 'data:image/png;base64,SHOULD_NOT_LEAK'
          }))
      }
    })
    return { handle, token: 'test-token-1234567890' }
  }

  function request(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
    const { token, ...rest } = init
    return fetch(`http://127.0.0.1:${handle!.port}${path}`, {
      ...rest,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })
  }

  it('writes the control descriptor into userData and removes it on close', async () => {
    const { handle: active, token } = await start()
    expect(active.filePath).toBe(join(dir, HEADLESS_CONTROL_FILENAME))
    const descriptor = JSON.parse(readFileSync(active.filePath, 'utf8'))
    expect(descriptor).toMatchObject({ pid: process.pid, port: active.port, token })
    await active.close()
    expect(existsSync(active.filePath)).toBe(false)
    handle = undefined
  })

  it('rejects requests without the bearer token and with foreign Host headers', async () => {
    const { token } = await start()
    const unauthorized = await request('/status')
    expect(unauthorized.status).toBe(401)
    const wrongToken = await request('/status', { token: 'wrong-token' })
    expect(wrongToken.status).toBe(401)
    // fetch() refuses to override Host, so use a raw request for the DNS-rebinding check.
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: handle!.port,
          path: '/status',
          headers: { Authorization: `Bearer ${token}`, Host: 'evil.example' }
        },
        (res) => {
          res.resume()
          resolve(res.statusCode)
        }
      )
      req.on('error', reject)
      req.end()
    })
    expect(badHostStatus).toBe(421)
  })

  it('serves /status with the remote status payload', async () => {
    const { token } = await start()
    const response = await request('/status', { token })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(status)
  })

  it('starts a pairing via POST /pair without leaking the desktop qrDataUrl', async () => {
    const { token } = await start()
    const response = await request('/pair', { method: 'POST', token })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      code: 'abc123',
      expiresAt: 1_700_000_000_000,
      pairingUrl: 'https://example.trycloudflare.com/#/pair?code=abc123'
    })
  })

  it('maps pairing preconditions (tunnel offline) to 409 with the message', async () => {
    const { token } = await start({
      startPairing: async () => {
        throw new Error('Remote-Gateway und Tunnel müssen für das Pairing online sein.')
      }
    })
    const response = await request('/pair', { method: 'POST', token })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'Remote-Gateway und Tunnel müssen für das Pairing online sein.'
    })
  })

  it('triggers the ordered shutdown on POST /shutdown', async () => {
    const quit = vi.fn()
    const { token } = await start({ quit })
    const response = await request('/shutdown', { method: 'POST', token })
    expect(response.status).toBe(202)
    await new Promise((resolve) => setImmediate(resolve))
    expect(quit).toHaveBeenCalledTimes(1)
    const unknown = await request('/nope', { token })
    expect(unknown.status).toBe(404)
  })
})

describe('headless CLI helpers (scripts/headless.mjs)', () => {
  it('parses subcommands and options', () => {
    expect(parseHeadlessCliArgs([])).toEqual({ command: 'start' })
    expect(parseHeadlessCliArgs(['status'])).toEqual({ command: 'status' })
    // pnpm forwards the `--` separator verbatim.
    expect(parseHeadlessCliArgs(['--', 'status'])).toEqual({ command: 'status' })
    expect(parseHeadlessCliArgs(['pair', '--user-data', 'C:\\data'])).toEqual({
      command: 'pair',
      userData: 'C:\\data'
    })
    expect(parseHeadlessCliArgs(['--timeout', '20'])).toEqual({ command: 'start', timeoutSec: 20 })
    expect(parseHeadlessCliArgs(['-h']).command).toBe('help')
  })

  it('rejects unknown commands, unknown flags and bad option values', () => {
    expect(parseHeadlessCliArgs(['launch']).error).toContain('Unbekanntes Kommando')
    expect(parseHeadlessCliArgs(['--frobnicate']).error).toContain('Unbekannte Option')
    expect(parseHeadlessCliArgs(['--user-data']).error).toContain('--user-data')
    expect(parseHeadlessCliArgs(['--timeout', '-5']).error).toContain('--timeout')
    expect(parseHeadlessCliArgs(['--timeout', 'soon']).error).toContain('--timeout')
  })

  it('recognizes the control announcement line and ignores everything else', () => {
    expect(
      parseControlAnnouncement('[headless] control=127.0.0.1:52342 file=C:\\Users\\x\\AppData\\Roaming\\vertragus\\headless-control.json')
    ).toEqual({ port: 52342, file: 'C:\\Users\\x\\AppData\\Roaming\\vertragus\\headless-control.json' })
    expect(parseControlAnnouncement('[headless] gateway=127.0.0.1:4711 tunnel=online devices=0')).toBeUndefined()
    expect(parseControlAnnouncement('random log line')).toBeUndefined()
  })

  it('derives dev + packaged userData candidates per platform', () => {
    expect(candidateUserDataDirs('win32', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'C:\\Users\\x')).toEqual([
      'C:\\Users\\x\\AppData\\Roaming\\vertragus',
      'C:\\Users\\x\\AppData\\Roaming\\Vertragus'
    ])
    expect(candidateUserDataDirs('linux', {}, '/home/x')).toEqual([
      '/home/x/.config/vertragus',
      '/home/x/.config/Vertragus'
    ])
    expect(candidateUserDataDirs('darwin', {}, '/Users/x')[0]).toBe(
      '/Users/x/Library/Application Support/vertragus'
    )
  })

  it('formats the status report in German including tunnel URL and errors', () => {
    const report = formatStatusReport({
      enabled: true,
      gatewayRunning: true,
      gatewayPort: 4711,
      tunnel: 'online',
      publicUrl: 'https://example.trycloudflare.com',
      deviceCount: 2
    }).join('\n')
    expect(report).toContain('Mission Control : aktiviert')
    expect(report).toContain('läuft auf 127.0.0.1:4711')
    expect(report).toContain('online — https://example.trycloudflare.com')
    expect(report).toContain('2 gepairt')

    const stopped = formatStatusReport({
      enabled: false,
      gatewayRunning: false,
      tunnel: 'disabled',
      deviceCount: 0,
      error: 'kaputt'
    }).join('\n')
    expect(stopped).toContain('deaktiviert')
    expect(stopped).toContain('gestoppt')
    expect(stopped).toContain('Fehler          : kaputt')
  })

  it('formats the pairing report with code, expiry and URL', () => {
    const expiresAt = new Date(2026, 6, 28, 9, 5).getTime()
    const report = formatPairingReport({
      code: 'abc123',
      expiresAt,
      pairingUrl: 'https://example.trycloudflare.com/#/pair?code=abc123'
    }).join('\n')
    expect(report).toContain('Code       : abc123')
    expect(report).toContain('Gültig bis : 09:05 Uhr')
    expect(report).toContain('URL        : https://example.trycloudflare.com/#/pair?code=abc123')
  })
})
