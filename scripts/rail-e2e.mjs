/**
 * Rail-E2E: startet die ECHTE App (Playwright/Electron) im Rail-Startmodus
 * gegen geseedetes userData und klickt jeden Rail-Workflow als Anwender durch:
 *
 *   1. Boot in die Rail, Profile sichtbar (Store-Hydration in Sekundärfenstern)
 *   2. Drag-Flächen: .rail = app-region drag, Buttons/Liste = no-drag
 *   3. Kanten-Snap + Persistenz nach einem programmatischen Move
 *   4. Yolo-Schalter (aria-pressed + hin/zurück)
 *   5. Live-Badges über den echten ev:agentsChanged-Broadcast
 *   6. Vollansicht-Button öffnet das Hauptfenster (Titelbar sichtbar)
 *   7. Fehlstart (Profil mit kaputtem Working Directory) zeigt eine sichtbare
 *      Fehlermeldung statt still zu scheitern; Dismiss räumt sie weg
 *   8. ✕ schließt die Rail; das Hauptfenster bleibt
 *
 * Screenshots jedes Schritts landen in e2e-artifacts/rail/.
 * Usage: pnpm run build && node scripts/rail-e2e.mjs
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifactsDir = join(repoRoot, 'e2e-artifacts', 'rail')
const mainEntry = join(repoRoot, 'out', 'main', 'index.js')

if (!existsSync(mainEntry)) {
  console.error('out/main/index.js fehlt — erst `pnpm run build` ausführen.')
  process.exit(2)
}
rmSync(artifactsDir, { recursive: true, force: true })
mkdirSync(artifactsDir, { recursive: true })

// --- geseedetes userData: Rail-Startmodus, 3 Profile (eins mit kaputtem Pfad) ---
const userData = mkdtempSync(join(tmpdir(), 'vertragus-rail-e2e-'))
writeFileSync(
  join(userData, 'vertragus.json'),
  JSON.stringify({
    schemaVersion: 5,
    activeProfileId: 'demo-uwe',
    profiles: [
      {
        id: 'demo-uwe',
        name: 'UWE Monorepo',
        workingDir: userData,
        orchestrator: { provider: 'claude', model: 'sonnet', autoOpenSubwindows: true },
        agents: [
          { role: 'codex', provider: 'codex', model: '', count: 3, orchestrated: true, yolo: true }
        ]
      },
      {
        id: 'demo-terra',
        name: 'Terra Art-Pipeline',
        workingDir: userData,
        agents: [
          { role: 'worker', provider: 'codex', model: '', count: 1, orchestrated: true, yolo: true }
        ]
      },
      {
        id: 'demo-broken',
        name: 'Kaputtes Profil',
        // Nicht existierendes Working Directory: der Start MUSS sichtbar scheitern.
        workingDir: 'C:\\definitiv\\nicht\\vorhanden',
        solo: true,
        agents: [
          { role: 'solo', provider: 'claude', model: 'sonnet', count: 1, orchestrated: false, yolo: true }
        ],
        planner: { mode: 'manual', routingMode: 'fixed', maxParallel: 1, maxRetries: 0 }
      }
    ],
    settings: {
      yoloMaster: true,
      'ui.theme': 'dark',
      'ui.startMode': 'rail',
      'ui.canvasDefaultApplied': true
    }
  }, null, 2)
)

const require_ = createRequire(import.meta.url)
const electronBinary = require_('electron')
const { _electron } = await import('playwright-core')

const results = []
let shotIndex = 0
async function step(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ok   ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error: error.message })
    console.error(`  FAIL ${name}: ${error.message}`)
  }
}
async function shot(page, name) {
  shotIndex += 1
  await page.screenshot({
    path: join(artifactsDir, `${String(shotIndex).padStart(2, '0')}-${name}.png`)
  })
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const app = await _electron.launch({
  executablePath: electronBinary,
  args: ['.', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
  cwd: repoRoot,
  env: {
    ...process.env,
    VERTRAGUS_E2E_USER_DATA: userData,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  }
})

try {
  const rail = await app.firstWindow()
  rail.on('pageerror', (error) => console.warn('[rail renderer]', error.message))

  await step('Boot: Rail-Fenster rendert 3 Profil-Kacheln (Store-Hydration)', async () => {
    await rail.waitForSelector('.rail', { timeout: 30_000 })
    await rail.waitForFunction(
      () => document.querySelectorAll('.rail-tile').length === 3,
      undefined,
      { timeout: 15_000 }
    )
    const names = await rail.$$eval('.rail-tile-name', (nodes) =>
      nodes.map((node) => node.textContent)
    )
    assert(names.includes('UWE Monorepo'), `Profilname fehlt: ${names.join(', ')}`)
    await shot(rail, 'boot')
  })

  await step('Drag-Flächen: .rail drag, Buttons/Liste no-drag', async () => {
    const regions = await rail.evaluate(() => {
      const region = (selector) =>
        getComputedStyle(document.querySelector(selector)).webkitAppRegion
      return {
        rail: region('.rail'),
        openMain: region('.rail-open-main'),
        close: region('.rail-close'),
        tiles: region('.rail-profiles'),
        yolo: region('.rail-action.yolo')
      }
    })
    assert(regions.rail === 'drag', `.rail app-region=${regions.rail}`)
    for (const [key, value] of Object.entries(regions)) {
      if (key === 'rail') continue
      assert(value === 'no-drag', `${key} app-region=${value}`)
    }
  })

  await step('Kanten-Snap + Persistenz nach einem Fenster-Move', async () => {
    const snapped = await app.evaluate(async ({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('/sidebar')
      )
      const workArea = screen.getPrimaryDisplay().workArea
      // In die Mitte schieben, dann nahe an die linke Kante: 'moved' feuert
      // auch für programmatische setPosition-Aufrufe und muss snappen.
      win.setPosition(workArea.x + Math.round(workArea.width / 2), workArea.y + 100)
      win.setPosition(workArea.x + 20, workArea.y + 100)
      await new Promise((resolvePause) => setTimeout(resolvePause, 400))
      const [x] = win.getPosition()
      return { x, expected: workArea.x + 12 }
    })
    assert(
      snapped.x === snapped.expected,
      `nicht gesnappt: x=${snapped.x}, erwartet ${snapped.expected}`
    )
  })

  await step('Yolo-Schalter: aria-pressed kippt und kommt zurück', async () => {
    const yolo = rail.locator('.rail-action.yolo')
    assert((await yolo.getAttribute('aria-pressed')) === 'true', 'Yolo startet nicht als aktiv')
    await yolo.click()
    await rail.waitForFunction(
      () => document.querySelector('.rail-action.yolo')?.getAttribute('aria-pressed') === 'false',
      undefined,
      { timeout: 5_000 }
    )
    await shot(rail, 'yolo-aus')
    await yolo.click()
    await rail.waitForFunction(
      () => document.querySelector('.rail-action.yolo')?.getAttribute('aria-pressed') === 'true',
      undefined,
      { timeout: 5_000 }
    )
  })

  await step('Live-Badges: ev:agentsChanged-Broadcast erreicht die Rail', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const payload = [
        { id: 'a1', name: 'Boromir', provider: 'codex', model: '', role: 'Task · worker', kind: 'sub', mode: 'task', yolo: true, workingDir: '.', status: 'running', startedAt: Date.now(), profileId: 'demo-uwe' },
        { id: 'a2', name: 'Caronte', provider: 'codex', model: '', role: 'Task · worker', kind: 'sub', mode: 'task', yolo: true, workingDir: '.', status: 'running', startedAt: Date.now(), profileId: 'demo-uwe' }
      ]
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('ev:agentsChanged', payload)
      }
    })
    await rail.waitForFunction(
      () => document.querySelector('.rail-tile-badge')?.textContent === '2',
      undefined,
      { timeout: 5_000 }
    )
    // Stop-Knopf erscheint neben der aktiven Kachel; erster Klick armiert nur.
    const stop = rail.locator('.rail-stop')
    assert((await stop.count()) === 1, 'Stop-Knopf fehlt bei laufendem Profil')
    await stop.click()
    assert(
      (await stop.getAttribute('class'))?.includes('confirm'),
      'Erster Stop-Klick armiert nicht'
    )
    await shot(rail, 'badges-und-stop')
    // Zurücksetzen: Broadcast ohne laufende Agenten.
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('ev:agentsChanged', [])
      }
    })
    await rail.waitForFunction(
      () => document.querySelectorAll('.rail-tile-badge').length === 0,
      undefined,
      { timeout: 5_000 }
    )
  })

  await step('Vollansicht-Button öffnet das Hauptfenster', async () => {
    const before = app.windows().length
    await rail.locator('.rail-open-main').click()
    const main = await app.waitForEvent('window', { timeout: 20_000 })
    await main.waitForSelector('.titlebar', { timeout: 30_000 })
    assert(app.windows().length === before + 1, 'kein neues Fenster')
    await shot(main, 'vollansicht')
  })

  await step('Fehlstart zeigt sichtbare Fehlermeldung + Dismiss', async () => {
    await rail.locator('.rail-tile', { hasText: 'Kaputtes Profil' }).click()
    await rail.waitForSelector('.rail-error', { timeout: 30_000 })
    const text = await rail.locator('.rail-error-text').textContent()
    assert((text ?? '').trim().length > 0, 'Fehlermeldung ist leer')
    await shot(rail, 'fehlstart')
    await rail.locator('.rail-error-dismiss').click()
    assert((await rail.locator('.rail-error').count()) === 0, 'Dismiss räumt nicht weg')
  })

  await step('✕ schließt die Rail, das Hauptfenster bleibt', async () => {
    const before = app.windows().length
    await rail.locator('.rail-close').click()
    await new Promise((resolvePause) => setTimeout(resolvePause, 800))
    assert(app.windows().length === before - 1, 'Rail-Fenster wurde nicht geschlossen')
  })
} finally {
  await app.close().catch(() => undefined)
  rmSync(userData, { recursive: true, force: true })
}

const failed = results.filter((result) => !result.ok)
writeFileSync(
  join(artifactsDir, 'rail-e2e-report.json'),
  `${JSON.stringify({ finishedAt: new Date().toISOString(), results }, null, 2)}\n`
)
console.log(`\nRail-E2E: ${results.length - failed.length}/${results.length} Schritte ok — Artefakte in e2e-artifacts/rail/`)
process.exit(failed.length > 0 ? 1 : 0)
