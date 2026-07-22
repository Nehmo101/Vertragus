/**
 * E2E smoke: renders every view of the app against the seeded test store
 * (scripts/testStore/seed.ts), takes light/dark screenshots at two widths and
 * runs in-page layout checks:
 *   - visual overlap: visible leaf elements that intersect > 30% of the
 *     smaller rect without being ancestors (outside an overlay allowlist)
 *   - content duplication: identical trimmed texts (> 12 chars) rendered
 *     more than once per view outside repeating list containers
 * Screenshots + JSON report land in e2e-artifacts/; exit != 0 on violations.
 *
 * Two engines:
 *   1. Electron (full app, preferred) — used when the Electron binary exists.
 *   2. Chromium renderer-only fallback — serves out/renderer and stubs
 *      window.vertragus with the seeded data. Used where the Electron binary
 *      cannot be downloaded (restricted networks); covers layout/content of
 *      the real renderer without the main process.
 *
 * Usage: node scripts/e2e-smoke.mjs   (pnpm run test:e2e; use xvfb-run on headless Linux)
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'

const cwd = process.cwd()
const artifactsDir = join(cwd, 'e2e-artifacts')
const mainEntry = join(cwd, 'out', 'main', 'index.js')
const rendererDir = join(cwd, 'out', 'renderer')

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status ?? 'unknown'})`)
  }
}

if (!existsSync(mainEntry) || !existsSync(join(rendererDir, 'index.html'))) {
  run('corepack', ['pnpm', 'exec', 'electron-vite', 'build'])
}

// Fresh seeded userData per run so results are deterministic.
const userData = join(tmpdir(), `vertragus-e2e-${Date.now().toString(36)}`)
mkdirSync(userData, { recursive: true })
run('corepack', ['pnpm', 'exec', 'tsx', '--tsconfig', 'tsconfig.node.json', 'scripts/testStore/seed.ts', userData])
mkdirSync(artifactsDir, { recursive: true })

const ROUTES = [
  { name: 'workspace', hash: '' },
  { name: 'inbox', hash: '#/inbox' },
  { name: 'remote', hash: '#/remote' },
  { name: 'approvals', hash: '#/approvals' },
  { name: 'changes', hash: '#/changes' },
  { name: 'voice', hash: '#/voice' }
]
const VIEWPORTS = [
  { name: 'wide', width: 1280, height: 800 },
  { name: 'narrow', width: 900, height: 800 }
]
const THEMES = ['light', 'dark']

/** Serialized into the page; must stay dependency-free. */
function analyzeView() {
  const OVERLAY_ALLOWLIST = [
    '[role="dialog"]',
    '[role="tooltip"]',
    '[data-overlay]',
    '.modal',
    '.toast',
    '.info-tip'
  ]
  const isAllowlisted = (element) =>
    OVERLAY_ALLOWLIST.some((selector) => element.closest(selector) !== null)
  const selectorFor = (element) => {
    const parts = []
    let current = element
    while (current && current !== document.body && parts.length < 5) {
      const cls = [...current.classList].slice(0, 2).join('.')
      parts.unshift(current.tagName.toLowerCase() + (cls ? `.${cls}` : ''))
      current = current.parentElement
    }
    return parts.join(' > ')
  }

  const all = [...document.body.querySelectorAll('*')]
  const visibleLeaves = all.filter((element) => {
    if (element.children.length > 0) return false
    // Vector graphics legitimately layer shapes; treat the <svg> as opaque.
    if (element.closest('svg')) return false
    // Children of a closed <details> are not part of the visible layout.
    const details = element.closest('details:not([open])')
    if (details && !element.closest('summary')) return false
    if (element.offsetParent === null && getComputedStyle(element).position !== 'fixed') return false
    const rect = element.getBoundingClientRect()
    if (rect.width < 4 || rect.height < 4) return false
    const style = getComputedStyle(element)
    return style.visibility !== 'hidden' && Number(style.opacity) > 0.05
  })

  // Clip an element's rect against every overflow-clipping ancestor — a child
  // scrolled/clipped out of view must not count as overlapping its neighbors.
  const clippedRect = (element) => {
    let rect = element.getBoundingClientRect()
    let ancestor = element.parentElement
    while (ancestor && ancestor !== document.body) {
      const style = getComputedStyle(ancestor)
      const clips = /(hidden|auto|scroll|clip)/.test(style.overflow + style.overflowX + style.overflowY)
      if (clips) {
        const bounds = ancestor.getBoundingClientRect()
        rect = {
          left: Math.max(rect.left, bounds.left),
          top: Math.max(rect.top, bounds.top),
          right: Math.min(rect.right, bounds.right),
          bottom: Math.min(rect.bottom, bounds.bottom)
        }
        rect.width = Math.max(0, rect.right - rect.left)
        rect.height = Math.max(0, rect.bottom - rect.top)
      }
      ancestor = ancestor.parentElement
    }
    return rect
  }

  const overlaps = []
  const seenPairs = new Set()
  for (let i = 0; i < visibleLeaves.length && overlaps.length < 20; i += 1) {
    for (let j = i + 1; j < visibleLeaves.length && overlaps.length < 20; j += 1) {
      const a = visibleLeaves[i]
      const b = visibleLeaves[j]
      if (a.contains(b) || b.contains(a)) continue
      if (isAllowlisted(a) || isAllowlisted(b)) continue
      const ra = clippedRect(a)
      const rb = clippedRect(b)
      if (ra.width < 4 || ra.height < 4 || rb.width < 4 || rb.height < 4) continue
      const x = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left))
      const y = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top))
      const intersection = x * y
      if (intersection <= 0) continue
      const smaller = Math.min(ra.width * ra.height, rb.width * rb.height)
      if (smaller > 0 && intersection / smaller > 0.3) {
        const key = [selectorFor(a), selectorFor(b)].sort().join(' ## ')
        if (seenPairs.has(key)) continue
        seenPairs.add(key)
        overlaps.push({
          a: selectorFor(a),
          b: selectorFor(b),
          ratio: Math.round((intersection / smaller) * 100) / 100
        })
      }
    }
  }

  const texts = new Map()
  const textBearing = [...document.body.querySelectorAll('h1,h2,h3,h4,button,label,[role="heading"]')]
  for (const element of textBearing) {
    if (element.offsetParent === null) continue
    // Repeating list rows legitimately share button labels.
    if (element.closest('ul,ol,table,[role="list"],[role="listbox"],[data-list]')) continue
    const text = (element.textContent ?? '').trim()
    if (text.length <= 12) continue
    const entry = texts.get(text) ?? { count: 0, selectors: [] }
    entry.count += 1
    if (entry.selectors.length < 4) entry.selectors.push(selectorFor(element))
    texts.set(text, entry)
  }
  const duplicates = [...texts.entries()]
    .filter(([, entry]) => entry.count > 1)
    .map(([text, entry]) => ({ text: text.slice(0, 80), count: entry.count, selectors: entry.selectors }))

  return { overlaps, duplicates }
}

/** window.vertragus stub for the Chromium renderer-only fallback. */
function buildStubInitScript(seedDir) {
  const config = JSON.parse(readFileSync(join(seedDir, 'vertragus.json'), 'utf8'))
  const inbox = JSON.parse(readFileSync(join(seedDir, 'vertragus-inbox.json'), 'utf8'))
  const seed = {
    profiles: config.profiles,
    activeProfileId: config.activeProfileId,
    mcpServers: config.settings.mcpServers,
    retros: config.settings.runRetros,
    learnings: config.settings.modelLearnings,
    benchmarks: config.settings.benchmarkRecords,
    ideas: inbox.ideas
  }
  return `
    const SEED = ${JSON.stringify(seed)};
    const ok = (value) => Promise.resolve(value);
    const noopOff = () => () => {};
    const CONFIG = {
      'ui.theme': 'light',
      'yoloMaster': false,
      'ui.canvasDefaultApplied': true
    };
    // Deep stub: any endpoint not explicitly overridden resolves to null;
    // subscription endpoints (on*) synchronously return an unsubscribe fn.
    const generic = () => new Proxy(function () {}, {
      get: (target, prop) => {
        if (prop === 'then') return undefined;
        if (typeof prop === 'string' && prop.startsWith('on')) return noopOff;
        if (prop === Symbol.toPrimitive) return () => '';
        return generic();
      },
      apply: () => Promise.resolve(null)
    });
    const api = generic();
    const overrides = {
      getAppInfo: () => ok({ name: 'Vertragus', version: 'e2e-smoke', platform: 'linux' }),
      listProfiles: () => ok(SEED.profiles),
      getActiveProfileId: () => ok(SEED.activeProfileId),
      setActiveProfileId: () => ok(undefined),
      listMcpServers: () => ok(SEED.mcpServers),
      checkProviders: () => ok([]),
      getProviderCapacity: () => ok({}),
      listModels: () => ok([]),
      getConfig: (key) => ok(Object.prototype.hasOwnProperty.call(CONFIG, key) ? CONFIG[key] : null),
      setConfig: (key, value) => { CONFIG[key] = value; return ok(undefined); },
      gitInfo: () => ok({ isRepo: false }),
      pickFolder: () => ok(undefined),
      onProvidersChanged: noopOff,
      agents: {
        list: () => ok([]),
        buffer: () => ok(''),
        bufferTail: () => ok(''),
        onData: noopOff,
        onChanged: noopOff,
        onEvent: noopOff
      },
      workspaceSessions: { list: () => ok([]), onChanged: noopOff },
      sessions: { restoreStatus: () => ok({
        cleanShutdown: true,
        restoredSessions: 0,
        resumableSessions: [],
        orphanedWorktrees: [],
        staleSessions: []
      }) },
      orchestrator: new Proxy({
        snapshot: (profileId, workspaceSessionId) => ok({
          profileId: profileId ?? SEED.activeProfileId,
          workspaceSessionId: workspaceSessionId,
          plannerMode: 'review',
          goal: null,
          tasks: [],
          pendingApprovals: [],
          pendingPermissions: [],
          findings: [],
          multiAgentRuns: [],
          subagentRequests: [],
          lastRetro: SEED.retros[0]
        }),
        onSnapshot: noopOff
      }, { get: (t, p) => t[p] ?? ((typeof p === 'string' && p.startsWith('on')) ? noopOff : () => ok(null)) }),
      inbox: new Proxy({
        list: () => ok(SEED.ideas),
        get: (id) => ok(SEED.ideas.find((idea) => idea.id === id) ?? null)
      }, { get: (t, p) => t[p] ?? (() => ok(null)) }),
      inboxSpeech: new Proxy({
        status: () => ok({ available: false }),
        getSettings: () => ok({})
      }, { get: (t, p) => t[p] ?? (() => ok(null)) }),
      remote: new Proxy({
        status: () => ok({ enabled: false }),
        listDevices: () => ok([]),
        getApnsConfigStatus: () => ok({ configured: false }),
        onStatus: noopOff
      }, { get: (t, p) => t[p] ?? ((typeof p === 'string' && p.startsWith('on')) ? noopOff : () => ok(null)) }),
      retro: {
        listRetros: () => ok(SEED.retros),
        listLearnings: () => ok(SEED.learnings),
        listBenchmarks: () => ok(SEED.benchmarks),
        syncStatus: () => ok({ enabled: false, queued: 0 }),
        syncFlush: () => ok({ enabled: false, queued: 0 })
      },
      updates: { state: () => ok({ status: 'idle' }), onState: noopOff },
      voiceAssistant: new Proxy({
        getSettings: () => ok({}),
        onProgress: noopOff
      }, { get: (t, p) => t[p] ?? ((typeof p === 'string' && p.startsWith('on')) ? noopOff : () => ok(null)) }),
      events: { onVoiceAssistant: noopOff, onUiCommand: noopOff },
      githubAuthStatus: () => ok({ authenticated: false, needsReauth: false, missingScopes: [], method: 'none' }),
      win: { minimize: () => {}, maximizeToggle: () => {}, close: () => {} },
      attention: { setPendingFeedbackCount: () => {} }
    };
    const merged = new Proxy(overrides, {
      get: (target, prop) => (prop in target ? target[prop] : api[prop])
    });
    Object.defineProperty(window, 'vertragus', { value: merged, configurable: true });
    Object.defineProperty(window, 'electron', { value: { process: { platform: 'linux' } }, configurable: true });
  `
}

function serveRenderer(dir) {
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.json': 'application/json'
  }
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    const relative = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^([/\\])+/, '')
    const file = join(dir, relative)
    if (!file.startsWith(dir) || !existsSync(file)) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((resolvePort) => {
    server.listen(0, '127.0.0.1', () => {
      resolvePort({ server, port: server.address().port })
    })
  })
}

const electronBinary = (() => {
  try {
    const pathTxt = join(cwd, 'node_modules', 'electron', 'path.txt')
    if (!existsSync(pathTxt)) return undefined
    const binary = join(cwd, 'node_modules', 'electron', 'dist', readFileSync(pathTxt, 'utf8').trim())
    return existsSync(binary) ? binary : undefined
  } catch {
    return undefined
  }
})()

const report = {
  startedAt: new Date().toISOString(),
  engine: electronBinary ? 'electron' : 'chromium-renderer-only',
  views: [],
  violations: 0
}

async function walkRoutes(page) {
  await page.waitForSelector('.app-root', { timeout: 30_000 })
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    for (const route of ROUTES) {
      await page.evaluate((hash) => {
        window.location.hash = hash
      }, route.hash)
      await page.waitForTimeout(600)
      for (const theme of THEMES) {
        await page.evaluate((value) => {
          document.querySelector('.app-root')?.setAttribute('data-theme', value)
        }, theme)
        await page.waitForTimeout(150)
        const shot = join(artifactsDir, `${route.name}-${viewport.name}-${theme}.png`)
        await page.screenshot({ path: shot, fullPage: false })
        if (theme === 'light') {
          const analysis = await page.evaluate(analyzeView)
          report.views.push({ route: route.name, viewport: viewport.name, ...analysis })
          report.violations += analysis.overlaps.length + analysis.duplicates.length
        }
      }
    }
    await page.evaluate(() => {
      window.location.hash = ''
    })
  }
}

const playwright = await import('playwright-core')
try {
  if (electronBinary) {
    const app = await playwright._electron.launch({
      args: ['.', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
      cwd,
      env: {
        ...process.env,
        VERTRAGUS_E2E_USER_DATA: userData,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      }
    })
    try {
      await walkRoutes(await app.firstWindow())
    } finally {
      await app.close().catch(() => undefined)
    }
  } else {
    console.warn('Electron-Binary nicht verfügbar — Chromium-Renderer-Fallback mit gestubbter Preload-API.')
    const { server, port } = await serveRenderer(rendererDir)
    const executablePath = process.env.VERTRAGUS_E2E_CHROMIUM ?? '/opt/pw-browsers/chromium'
    const browser = await playwright.chromium.launch({
      executablePath: existsSync(executablePath) ? executablePath : undefined,
      args: ['--no-sandbox']
    })
    try {
      const context = await browser.newContext({ viewport: VIEWPORTS[0] })
      await context.addInitScript(buildStubInitScript(userData))
      const page = await context.newPage()
      page.on('pageerror', (error) => console.warn('[renderer]', error.message))
      await page.goto(`http://127.0.0.1:${port}/index.html`)
      await walkRoutes(page)
    } finally {
      await browser.close().catch(() => undefined)
      server.close()
    }
  }
} finally {
  rmSync(userData, { recursive: true, force: true })
}

const reportPath = join(artifactsDir, 'e2e-report.json')
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`E2E-Report (${report.engine}): ${reportPath}`)
for (const view of report.views) {
  const status = view.overlaps.length + view.duplicates.length === 0 ? 'ok' : 'VERSTOESSE'
  console.log(
    `  ${view.route}/${view.viewport}: ${status}` +
      (view.overlaps.length ? ` overlaps=${view.overlaps.length}` : '') +
      (view.duplicates.length ? ` duplicates=${view.duplicates.length}` : '')
  )
}
if (report.violations > 0) {
  console.error(`E2E smoke: ${report.violations} Layout-/Duplikat-Verstöße — Details im Report.`)
  process.exit(1)
}
console.log('E2E smoke passed.')
