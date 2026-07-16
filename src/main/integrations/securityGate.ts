const MAX_DIFF_BYTES = 5 * 1024 * 1024

export type SecuritySurface = 'ipc' | 'filesystem' | 'oauth' | 'secret'
export type SecurityControl = 'authorization' | 'validation' | 'path-traversal' | 'secret-leak'

export interface SecurityFinding {
  surface: SecuritySurface
  files: string[]
  requiredControls: SecurityControl[]
  missingControls: SecurityControl[]
}

export interface SecurityGateReport {
  sensitiveFiles: string[]
  detectedSurfaces: SecuritySurface[]
  verifiedControls: SecurityControl[]
  findings: SecurityFinding[]
}

export class SecurityGateError extends Error {
  readonly code = 'security-controls-missing'
  constructor(readonly report: SecurityGateReport, message: string) {
    super(message)
    this.name = 'SecurityGateError'
  }
}

const leakedSecretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[opsu]_[A-Za-z0-9]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{32,}\b/
]

const surfacePatterns: Record<SecuritySurface, RegExp> = {
  ipc: /\b(?:ipcMain|ipcRenderer|contextBridge)\b|\bwebContents\.send\b|\bregister\w*Ipc\b|(?:^|[/.-])ipc(?:[/.-]|$)|(?:^|\/)preload/i,
  filesystem:
    /\bnode:(?:fs|path)\b|\bfrom\s+['"](?:fs|path)['"]|\b(?:readFile|writeFile|mkdir|unlink|rename|copyFile|createReadStream|createWriteStream|realpath)\b/i,
  oauth: /\boauth\b|\bpkce\b|\bcodeVerifier\b|\bredirectUri\b|\bauthorizationEndpoint\b/i,
  secret:
    /\b(?:clientSecret|apiKey|accessToken|refreshToken|secretValue)\b|\bAuthorization\b|\bBearer\b|\bprocess\.env\b|(?:^|[/.-])secrets?(?:[/.-]|$)/i
}

const requiredControls: Record<SecuritySurface, SecurityControl[]> = {
  ipc: ['authorization', 'validation'],
  filesystem: ['validation', 'path-traversal'],
  oauth: ['authorization', 'validation', 'secret-leak'],
  secret: ['secret-leak']
}

const controlEvidence: Record<SecurityControl, RegExp> = {
  authorization:
    /unauthori[sz]ed|forbidden|permission|access denied|not allowed|denied|berechtigung|zugriff verweigert|invalid (?:role|scope|state)/i,
  validation: /invalid|malformed|rejects?|toThrow|safeParse|validat(?:e|ion)|ung(?:u|\u00fc)ltig/i,
  'path-traversal':
    /path traversal|directory traversal|\.\.[\\/]|outside (?:the )?root|escape(?:s|d)? (?:the )?root|symlink/i,
  'secret-leak':
    /redact|mask(?:ed|ing)?|not\.toContain|secret leak|leak(?:s|ed)? (?:a )?secret|without (?:a )?secret|kein secret|(?:token|authorization).*undefined/i
}

function isTestFile(path: string): boolean {
  return /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?)$/i.test(path)
}

/**
 * Documentation is no executable attack surface: a Markdown file that merely
 * CATALOGS security vocabulary (OAuth routes, token entities) must not demand
 * negative tests. Leaked-secret patterns still apply to documentation.
 */
function isDocumentationFile(path: string): boolean {
  return /(?:^|\/)(?:docs?|documentation)\//i.test(path) ||
    /\.(?:md|mdx|markdown|rst|adoc|txt)$/i.test(path)
}

/** Minimal glob support for configured excludes: `**` crosses directories, `*` does not. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .split('\u0000')
    .join('.*')
  return new RegExp(`^${escaped}$`, 'i')
}

export interface SecurityGateOptions {
  /**
   * Additional path globs excluded from the surface scan (never from the
   * leaked-secret scan). Sourced from AutoPrConfig.securityGateExcludes.
   */
  excludePaths?: readonly string[]
}

function surfaceScanExclusions(options?: SecurityGateOptions): RegExp[] {
  return (options?.excludePaths ?? []).map(globToRegExp)
}

function addedLinesByFile(diff: string): Map<string, string[]> {
  const files = new Map<string, string[]>()
  let currentFile: string | undefined

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const rawPath = line.slice(4).trim()
      currentFile = rawPath === '/dev/null' ? undefined : rawPath.replace(/^b\//, '')
      if (currentFile && !files.has(currentFile)) files.set(currentFile, [])
      continue
    }
    if (currentFile && line.startsWith('+') && !line.startsWith('+++')) {
      files.get(currentFile)?.push(line.slice(1))
    }
  }

  // Pure snippets are useful for the small compatibility helper and secret scanning.
  if (files.size === 0) {
    files.set(
      '<diff>',
      diff
        .split(/\r?\n/)
        .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
        .map((line) => line.slice(1))
    )
  }
  return files
}

export function evaluateSecurityGate(diff: string, options?: SecurityGateOptions): SecurityGateReport {
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) {
    throw new Error('Diff ist groesser als 5 MiB; Security Gate wurde sicherheitshalber blockiert.')
  }

  const files = addedLinesByFile(diff)
  const allAddedLines = [...files.values()].flat().join('\n')
  if (leakedSecretPatterns.some((pattern) => pattern.test(allAddedLines))) {
    throw new Error('Moegliches Secret in hinzugefuegten Diff-Zeilen erkannt; Security Gate wurde blockiert.')
  }

  const testEvidence = [...files.entries()]
    .filter(([path]) => isTestFile(path))
    .flatMap(([path, lines]) => [path, ...lines])
    .join('\n')
  const verifiedControls = (Object.keys(controlEvidence) as SecurityControl[]).filter((control) =>
    controlEvidence[control].test(testEvidence)
  )

  const exclusions = surfaceScanExclusions(options)
  const filesBySurface = new Map<SecuritySurface, Set<string>>()
  for (const [path, lines] of files) {
    if (path === '<diff>' || isTestFile(path) || isDocumentationFile(path)) continue
    if (exclusions.some((pattern) => pattern.test(path))) continue
    const addedSource = `${path}\n${lines.join('\n')}`
    for (const surface of Object.keys(surfacePatterns) as SecuritySurface[]) {
      if (surfacePatterns[surface].test(addedSource)) {
        const paths = filesBySurface.get(surface) ?? new Set<string>()
        paths.add(path)
        filesBySurface.set(surface, paths)
      }
    }
  }

  const findings: SecurityFinding[] = []
  for (const [surface, paths] of filesBySurface) {
    const required = requiredControls[surface]
    const missingControls = required.filter((control) => !verifiedControls.includes(control))
    if (missingControls.length > 0) {
      findings.push({
        surface,
        files: [...paths].sort(),
        requiredControls: [...required],
        missingControls
      })
    }
  }

  return {
    sensitiveFiles: [...new Set([...filesBySurface.values()].flatMap((paths) => [...paths]))].sort(),
    detectedSurfaces: [...filesBySurface.keys()],
    verifiedControls,
    findings
  }
}

export function securityChecklistForFiles(files: readonly string[]): string[] {
  const normalized = files.map((file) => file.replace(/\\/g, '/').toLowerCase())
  const surfaces = new Set<SecuritySurface>()
  for (const file of normalized) {
    if (/(^|\/)src\/(?:main\/ipc|preload)(?:\/|$)|(?:^|[/.-])ipc(?:[/.-]|$)/.test(file)) surfaces.add('ipc')
    if (/(?:^|\/)(?:files?|paths?|worktree|workspace|storage)(?:[/.-]|$)/.test(file)) surfaces.add('filesystem')
    if (/(?:oauth|auth|login|pkce)/.test(file)) surfaces.add('oauth')
    if (/(?:secret|credential|token|config)/.test(file)) surfaces.add('secret')
  }
  const controls = new Set<SecurityControl>()
  for (const surface of surfaces) {
    for (const control of requiredControls[surface]) controls.add(control)
  }
  const labels: Record<SecurityControl, string> = {
    authorization: 'Autorisierungs-Negativtest (unberechtigter Aufruf wird abgewiesen)',
    validation: 'Validierungs-Negativtest (ungültige Eingabe wird abgewiesen)',
    'path-traversal': 'Path-Traversal-/Symlink-Negativtest (Workspace-Grenze kann nicht verlassen werden)',
    'secret-leak': 'Secret-Leak-/Redaktions-Negativtest (Token und Credentials erscheinen nicht in Ausgabe)'
  }
  return [...controls].map((control) => labels[control])
}

export function assertSecurityGate(diff: string, options?: SecurityGateOptions): SecurityGateReport {
  const report = evaluateSecurityGate(diff, options)
  if (report.findings.length === 0) return report

  const details = report.findings
    .map(
      (finding) =>
        `${finding.surface} (${finding.files.join(', ')}): ${finding.missingControls.join(', ')}`
    )
    .join('; ')
  throw new SecurityGateError(
    report,
    `Security Gate fehlgeschlagen; erforderliche Negativtests fehlen: ${details}`
  )
}
