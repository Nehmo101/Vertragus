# Code signing and notarization

## Current status: Windows and Linux builds are unsigned

Nothing published today carries a code signature. On Windows that means
SmartScreen interrupts the first run of a downloaded installer with
"Windows protected your PC" — click **More info → Run anyway** to proceed.
That is a known, accepted cost until the signing certificates exist; the
plumbing for signing is already in place (see below) and activates the moment
the repository secrets are configured, with no further code change.

There are **no macOS files in releases yet** — deliberately, see below.

## Verifying a download

Every release carries the update-channel metadata files electron-builder
generates (`latest.yml` for tagged releases, `main.yml` for `main`-channel
prereleases, plus `latest-mac.yml` / `main-mac.yml` / `*-linux.yml` per
platform). Each lists the release's files with their **sha512 in base64** —
the exact value the auto-updater itself verifies before installing. To check a
manual download against it:

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
`latest.yml` / `main.yml`. A mismatch means the download is corrupt or not the
file the release published — do not run it.

## Why the macOS release only ships signed

Squirrel.Mac — the framework behind Electron's auto-updater on macOS —
**refuses to apply updates that are not validly signed**. An unsigned macOS
release would install once and then never update itself: a dead updater
disguised as a working app. That is why the release workflow builds macOS on
every run (so packaging regressions surface) but only **publishes** the mac
artifacts when the full set of Apple signing secrets exists. Until then,
releases simply contain no mac files.

## What the workflow expects

Signing is gated purely on repository secrets. Secrets that do not exist
arrive in the workflow as empty strings, so the release workflow
(`.github/workflows/release.yml`, step "Detect signing secrets") treats a
platform as signing-enabled only when its **complete** set is non-empty —
anything less builds unsigned exactly as before (with a workflow warning if
the set is only partially configured).

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
because electron-builder 26's native `win.azureSignOptions` activates on mere
config presence and would fail every certificate-less build; the hook keeps
the gate in the environment and no-ops loudly when the variables are absent.

### macOS — Developer ID + notarization

| Secret | Meaning |
| --- | --- |
| `CSC_LINK` | Developer ID Application certificate, base64-encoded `.p12` |
| `CSC_KEY_PASSWORD` | Password of that `.p12` |
| `APPLE_ID` | Apple ID that owns the app-specific password |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for `notarytool` |
| `APPLE_TEAM_ID` | Developer team id |

electron-builder consumes `CSC_*` for signing; `mac.notarize: true` in
`electron-builder.yml` submits to Apple's notary service using the `APPLE_*`
variables and staples the ticket to the app. The hardened-runtime
entitlements live in `build/entitlements.mac.plist` (JIT, unsigned executable
memory, library validation off — Electron plus node-pty's native binding
need all three).

### Verification is part of the build

When signing was enabled, the workflow proves it worked before uploading:
`Get-AuthenticodeSignature` must report `Valid` on the Windows installer, and
on macOS the built dmg is mounted and the app inside must pass
`spctl -a -vv -t execute` and `xcrun stapler validate`. A signing-enabled
build that produced unsigned artifacts fails loudly instead of shipping.

## Flip-on plan

1. **Now (done):** everything above is merged but dormant — zero behavior
   change while the secrets are absent.
2. **When the certificates exist:** add the secrets to the repository; the
   next release is signed (Windows) and signed + notarized + published
   (macOS). No code change.
3. **After the first signed release, before the 1.0 tag:** pin
   `publisherName` for the Windows updater so installed apps verify that
   every future update is signed by the same publisher. The pin must not
   land earlier: it is baked into the installed app and makes it reject any
   update that does not carry that signature — an app pinned while releases
   are still unsigned could never update again. Signed releases first, the
   pin second.
