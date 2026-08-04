/**
 * Rail-Screenshot-Smoke: bootet die gebaute App direkt in den Rail-Modus gegen
 * ein isoliertes, geseedetes userData (3 Demo-Profile, eine laufende Session
 * kommt hier nicht vor) und lässt das Rail-Fenster sich selbst capturen.
 *
 *   pnpm run build && node scripts/rail-smoke.mjs [ausgabe.png] [--theme dark|light]
 *
 * Der Screenshot ist der Abnahme-Artefakt: Profile sichtbar, Vollansicht-Button
 * vorhanden, kein opaker App-Hintergrund im transparenten Fenster.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const themeIndex = args.indexOf('--theme')
const theme = themeIndex >= 0 ? args[themeIndex + 1] : 'dark'
const shotPath = resolve(
  args.find((arg) => arg.endsWith('.png')) ?? join(repoRoot, `rail-smoke-${theme}.png`)
)

if (!existsSync(join(repoRoot, 'out', 'main', 'index.js'))) {
  console.error('out/main/index.js fehlt — erst `pnpm run build` ausführen.')
  process.exit(2)
}

const userData = mkdtempSync(join(tmpdir(), 'vertragus-rail-smoke-'))
mkdirSync(userData, { recursive: true })
writeFileSync(
  join(userData, 'vertragus.json'),
  JSON.stringify(
    {
      schemaVersion: 5,
      activeProfileId: 'demo-uwe',
      profiles: [
        {
          id: 'demo-uwe',
          name: 'UWE Monorepo',
          workingDir: 'C:\\git\\demo',
          orchestrator: { provider: 'claude', model: 'sonnet', autoOpenSubwindows: true },
          agents: [
            { role: 'codex', provider: 'codex', model: '', count: 3, orchestrated: true, yolo: true }
          ]
        },
        {
          id: 'demo-terra',
          name: 'Terra Art-Pipeline',
          workingDir: 'C:\\git\\demo',
          agents: [
            { role: 'worker', provider: 'codex', model: '', count: 1, orchestrated: true, yolo: true }
          ]
        },
        {
          id: 'demo-solo',
          name: 'Efficiency Solo',
          workingDir: 'C:\\git\\demo',
          solo: true,
          agents: [
            { role: 'solo', provider: 'claude', model: 'sonnet', count: 1, orchestrated: false, yolo: true }
          ],
          planner: { mode: 'manual', routingMode: 'fixed', maxParallel: 1, maxRetries: 0 }
        }
      ],
      settings: {
        yoloMaster: true,
        'ui.theme': theme,
        'ui.startMode': 'rail',
        'ui.canvasDefaultApplied': true
      }
    },
    null,
    2
  )
)

const electronBin = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron'
)
const child = spawn(electronBin, ['.'], {
  cwd: repoRoot,
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    VERTRAGUS_RAIL_SCREENSHOT: shotPath,
    VERTRAGUS_RAIL_SCREENSHOT_DATA: userData
  },
  stdio: 'inherit'
})

const timeout = setTimeout(() => {
  console.error('Rail-Smoke: Timeout — App beendet sich nicht selbst.')
  child.kill()
}, 60_000)

child.on('exit', (code) => {
  clearTimeout(timeout)
  rmSync(userData, { recursive: true, force: true })
  if (existsSync(shotPath)) {
    console.log(`Rail-Screenshot geschrieben: ${shotPath}`)
    process.exit(0)
  }
  console.error(`Rail-Smoke fehlgeschlagen (exit=${code}), kein Screenshot.`)
  process.exit(1)
})
