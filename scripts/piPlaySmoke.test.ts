/**
 * Guard: the Pi Play smoke has to stay wired. A missing CI step or a boot
 * hook that never calls `armPiPlaySmoke` would green `pnpm run ci` while
 * Windows ConPTY + electron.exe stayed a blank agent window.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { childEnv, inspectPiPlayLog, PROVIDER_KEY_ENVS, STORE_FILE } from './pi-play-smoke.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = join(repoRoot, 'scripts', 'pi-play-smoke.mjs')
const ciPath = join(repoRoot, '.github', 'workflows', 'ci.yml')
const indexPath = join(repoRoot, 'src', 'main', 'index.ts')
const settingsPath = join(repoRoot, 'src', 'main', 'store', 'settings.ts')

describe('Pi Play smoke wiring', () => {
  it('the driver script exists — this guard is not matching a deleted file', () => {
    expect(existsSync(scriptPath)).toBe(true)
  })

  it('CI quality, linux and macos run the driver after panel-smoke', () => {
    const ci = readFileSync(ciPath, 'utf8')
    const hits = ci.match(/node scripts\/pi-play-smoke\.mjs/g) ?? []
    expect(hits.length, ci).toBeGreaterThanOrEqual(3)
    expect(ci).toContain('xvfb-run -a node scripts/pi-play-smoke.mjs')
    // Self-check: a regex that stopped matching would otherwise green.
    expect(ci).toMatch(/Panel smoke/)
  })

  it('index applies isolated userData before whenReady and arms the PTY hook', () => {
    const source = readFileSync(indexPath, 'utf8')
    expect(source).toContain('applyIsolatedUserData()')
    expect(source.indexOf('applyIsolatedUserData()')).toBeLessThan(source.indexOf('app.whenReady'))
    expect(source).toContain('armPiPlaySmoke')
    expect(source).toContain('VERTRAGUS_PI_PLAY_SMOKE')
    expect(source).toContain('pty.snapshot()')
  })

  it('writes the same store file name the settings module uses', () => {
    const settings = readFileSync(settingsPath, 'utf8')
    expect(STORE_FILE).toBe('vertragus-v2.json')
    expect(settings).toContain("STORE_NAME = 'vertragus-v2'")
  })

  it('is not part of pnpm run ci — Electron GUI, ~20–40s', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    expect(pkg.scripts.ci).not.toMatch(/pi-play-smoke/)
  })
})

describe('childEnv', () => {
  it('strips billed provider keys so isolated HOME cannot spend tokens', () => {
    const env = childEnv(
      {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'sk-secret',
        OPENAI_API_KEY: 'sk-openai',
        XAI_API_KEY: 'xai',
        ELECTRON_RUN_AS_NODE: '1',
        PI_CODING_AGENT_DIR: 'C:\\Users\\dev\\.pi\\agent',
        VERTRAGUS_DEV_GOAL: 'spend tokens',
        VERTRAGUS_PANEL_SCREENSHOT: 'C:\\tmp\\panel.png'
      },
      { HOME: '/tmp/home' }
    )
    expect(env.HOME).toBe('/tmp/home')
    expect(env.PATH).toBe('/bin')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
    expect(env.VERTRAGUS_DEV_GOAL).toBeUndefined()
    expect(env.VERTRAGUS_PANEL_SCREENSHOT).toBeUndefined()
    for (const key of PROVIDER_KEY_ENVS) {
      expect(env[key]).toBeUndefined()
    }
  })
})

describe('inspectPiPlayLog', () => {
  it('accepts a passing verdict and rejects empty or failing logs', () => {
    expect(inspectPiPlayLog('status=pass\nreason=ok\n')).toBeNull()
    expect(inspectPiPlayLog('')).toMatch(/no log/i)
    expect(inspectPiPlayLog('status=fail\nreason=blank\n')).toMatch(/did not pass/)
  })
})
