#!/usr/bin/env node
/**
 * azure-sign — the `win.signtoolOptions.sign` hook: Azure Trusted Signing,
 * gated on the environment.
 *
 * electron-builder 26 supports Azure Trusted Signing natively via
 * `win.azureSignOptions`, but the mere presence of that key in the config
 * switches the Windows signing manager and fails every build that has no
 * Azure credentials — a static config cannot be secrets-gated that way.
 * This hook keeps the config static and moves the gate into the environment:
 *
 *   - none of the required variables set  → loud no-op; the artifact stays
 *     unsigned and the build stays green (today's behavior, forks included).
 *   - all of them set                     → Invoke-TrustedSigning signs the
 *     file; any failure fails the build.
 *   - only some of them set               → hard error. A half-configured
 *     signing setup must never silently ship unsigned binaries.
 *
 * Required environment (see docs/SIGNING.md and .github/workflows/release.yml):
 *   AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
 *     — read by the TrustedSigning module's EnvironmentCredential
 *   AZURE_CODE_SIGNING_ENDPOINT
 *   AZURE_CODE_SIGNING_ACCOUNT_NAME
 *   AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME
 *     — passed to Invoke-TrustedSigning
 *
 * The Invoke-TrustedSigning call mirrors electron-builder's own
 * WindowsSignAzureManager, so switching to native `azureSignOptions` later
 * (WP-2 PR3, once secrets exist and gating can move) changes nothing on disk.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const REQUIRED_ENV = [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_CODE_SIGNING_ENDPOINT',
  'AZURE_CODE_SIGNING_ACCOUNT_NAME',
  'AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME'
]

function presentEnv() {
  return REQUIRED_ENV.filter((name) => (process.env[name] ?? '').trim() !== '')
}

/** PowerShell single-quoted literal: only `'` needs escaping (doubled). */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

async function powershell(command) {
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    maxBuffer: 16 * 1024 * 1024
  })
}

let moduleReady
function ensureTrustedSigningModule() {
  // The same bootstrap electron-builder's Azure manager performs; memoized so
  // app binary, uninstaller and installer do not reinstall it per file.
  moduleReady ??= (async () => {
    try {
      await powershell(
        'Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser'
      )
    } catch {
      // GitHub runners usually ship NuGet already; if it is truly missing,
      // the Install-Module below fails with the real error message.
    }
    await powershell(
      'Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser'
    )
  })()
  return moduleReady
}

let announcedSkip = false

/** @param {{ path: string, hash: string }} configuration */
export default async function sign(configuration) {
  const present = presentEnv()
  if (present.length === 0) {
    if (!announcedSkip) {
      announcedSkip = true
      console.warn(
        '[azure-sign] SKIPPED — building UNSIGNED Windows binaries: none of ' +
          `${REQUIRED_ENV.join(', ')} are set. See docs/SIGNING.md.`
      )
    }
    return
  }
  if (present.length < REQUIRED_ENV.length) {
    const missing = REQUIRED_ENV.filter((name) => !present.includes(name))
    throw new Error(
      `[azure-sign] refusing a half-configured signing setup — missing: ${missing.join(', ')}`
    )
  }
  // electron-builder calls the hook once per hash for dual signing; Azure
  // Trusted Signing is SHA256-only, so the sha1 pass is skipped.
  if (configuration.hash === 'sha1') return

  await ensureTrustedSigningModule()
  const args = [
    ['Endpoint', process.env.AZURE_CODE_SIGNING_ENDPOINT],
    ['CodeSigningAccountName', process.env.AZURE_CODE_SIGNING_ACCOUNT_NAME],
    ['CertificateProfileName', process.env.AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME],
    ['TimestampRfc3161', 'http://timestamp.acs.microsoft.com'],
    ['TimestampDigest', 'SHA256'],
    ['FileDigest', 'SHA256'],
    ['Files', configuration.path]
  ]
    .map(([name, value]) => `-${name} ${psQuote(value)}`)
    .join(' ')
  console.log(`[azure-sign] signing ${configuration.path}`)
  await powershell(`Invoke-TrustedSigning ${args}`)
}
