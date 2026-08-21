English | [Deutsch](SIGNING.de.md)

# Code signing and notarization

## Vertragus ships unsigned — on purpose

Nothing published carries a code signature, and that is a decision, not a
gap waiting to be filled. Certificates are a recurring cost (a Windows
certificate authority subscription plus 99 USD per year for an Apple
Developer account) that this project does not carry.

What that means for you:

- **Windows:** SmartScreen interrupts the first run of a downloaded
  installer with "Windows protected your PC". Click **More info → Run
  anyway**. Verify the download first if you want certainty — see below.
- **Linux:** AppImage and deb are unsigned, like most independently
  published Linux builds. Verify the hash the same way.
- **macOS:** releases contain **no mac files at all**. Build it yourself
  from a checkout (`pnpm install && pnpm run build:mac`). The reason is in
  its own section below — an unsigned mac release would be worse than none.

The signing machinery is fully implemented and dormant: if certificates
ever appear, adding repository secrets is the only step. Nothing about it
runs, warns or slows a build while the secrets are absent.

## Verifying a download

Every release carries the update-channel metadata files electron-builder
generates (`latest.yml` for tagged releases, `main.yml` for `main`-channel
prereleases, plus per-platform variants). Each lists the release's files
with their **sha512 in base64** — the exact value the auto-updater itself
verifies before installing. To check a manual download against it:

```bash
# macOS / Linux / Git Bash on Windows
openssl dgst -sha512 -binary Vertragus-<version>-setup.exe | openssl base64 -A
```

```powershell
# PowerShell 7+
$hash = (Get-FileHash -Algorithm SHA512 .\Vertragus-<version>-setup.exe).Hash
[Convert]::ToBase64String([Convert]::FromHexString($hash))
```

Compare the output with the `sha512:` entry for that file in the release's
`latest.yml` / `main.yml`. A mismatch means the download is corrupt or not
the file the release published — do not run it.

This is the honest security story of an unsigned build: the hash proves the
file matches what the public CI run produced, and the build is reproducible
from a public commit. A signature would prove the same thing without the
manual step.

## Why there is no macOS release

Squirrel.Mac — the framework behind Electron's auto-updater on macOS —
**refuses to apply updates that are not validly signed**. An unsigned macOS
release would install once and then never update itself: a dead updater
disguised as a working app, on the one platform where users expect updates
to be invisible. Shipping nothing is the more honest option.

The release workflow still **builds** macOS on every run so packaging
regressions surface, and simply never publishes those artifacts. Local
`pnpm run build:mac` produces the same app; Gatekeeper will quarantine it,
which `xattr -dr com.apple.quarantine /Applications/Vertragus.app` clears
for a build you compiled yourself.

## What the workflow expects if signing is ever enabled

Signing is gated purely on repository secrets. Secrets that do not exist
arrive in the workflow as empty strings, so the release workflow
(`.github/workflows/release.yml`, step "Detect signing secrets") treats a
platform as signing-enabled only when its **complete** set is non-empty —
anything less builds unsigned exactly as it does today (with a workflow
warning if the set is only partially configured).

### Windows — Azure Trusted Signing

| Secret | Meaning |
| --- | --- |
| `AZURE_TENANT_ID` | Entra ID tenant of the service principal |
| `AZURE_CLIENT_ID` | Service principal (app registration) id |
| `AZURE_CLIENT_SECRET` | Service principal secret |
| `AZURE_CODE_SIGNING_ENDPOINT` | Trusted Signing account endpoint URI (region-specific) |
| `AZURE_CODE_SIGNING_ACCOUNT_NAME` | Trusted Signing account name |
| `AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME` | Certificate profile inside that account |

The first three are read by the TrustedSigning PowerShell module's
`EnvironmentCredential`; the latter three are passed to
`Invoke-TrustedSigning` by `scripts/azure-sign.mjs`, the
`win.signtoolOptions.sign` hook in `electron-builder.yml`. The hook exists
because electron-builder 26's native `win.azureSignOptions` activates on
mere config presence and would fail every certificate-less build; the hook
keeps the gate in the environment and no-ops loudly when the variables are
absent.

### macOS — Developer ID + notarization

| Secret | Meaning |
| --- | --- |
| `CSC_LINK` | Developer ID Application certificate, base64-encoded `.p12` |
| `CSC_KEY_PASSWORD` | Password of that `.p12` |
| `APPLE_ID` | Apple ID that owns the app-specific password |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for `notarytool` |
| `APPLE_TEAM_ID` | Developer team id |

electron-builder consumes `CSC_*` for signing; `mac.notarize: true` in
`electron-builder.yml` submits to Apple's notary service using the
`APPLE_*` variables and staples the ticket to the app. The hardened-runtime
entitlements live in `build/entitlements.mac.plist` (JIT, unsigned
executable memory, library validation off — Electron plus node-pty's native
binding need all three).

### Verification is part of the build

When signing is enabled, the workflow proves it worked before uploading:
`Get-AuthenticodeSignature` must report `Valid` on the Windows installer,
and on macOS the built dmg is mounted and the app inside must pass
`spctl -a -vv -t execute` and `xcrun stapler validate`. A signing-enabled
build that produced unsigned artifacts fails loudly instead of shipping.

## The free path, if it is ever wanted

For Windows only, [SignPath Foundation](https://signpath.org/) issues free
OV code-signing certificates to qualifying open-source projects and holds
the key in its own HSM, so nothing secret enters this repository. The
trade-off is that the publisher shown in Windows dialogs is "SignPath
Foundation" rather than the project, applications take days to weeks, and
the certificate would replace the Azure path above (a small change in
`scripts/azure-sign.mjs`). There is no equivalent for macOS: Apple's 99 USD
per year is the only route to a notarized mac build.

Whenever a first signed release happens, one follow-up belongs with it:
pin `publisherName` for the Windows updater so installed apps verify that
every future update carries the same publisher. That pin must land **after**
the first signed release, never before — it is baked into the installed app
and makes it reject any update without that signature, so an app pinned
while releases are still unsigned could never update again.
