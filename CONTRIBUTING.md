English | [Deutsch](CONTRIBUTING.de.md)

# Contributing to Vertragus

## Build and test

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev          # launch with HMR
corepack pnpm run test     # vitest, once
corepack pnpm run ci       # lint + typecheck (node & web) + tests + both builds
```

`pnpm run ci` is the canonical gate — the same command CI runs on Windows
(the primary, owner-verified platform), Linux and macOS. CI additionally
runs the coverage ratchet (`pnpm run test:coverage`; thresholds in
`vitest.config.ts` sit just below the measured status quo, so coverage can
only move up) and a panel smoke test that boots the real Electron app
(`scripts/panel-smoke.mjs`). A packaging job proves the installers still
build; nothing is published from CI.

Useful pieces: `pnpm run typecheck:node` / `typecheck:web` for one project,
`pnpm run test:watch` during development, `pnpm run icons` to regenerate
icons from `build/icon.svg`, and `VERTRAGUS_DEV_RUN=<repo> pnpm dev` for a
headless dev workspace on a real repository.

## Pull request expectations

- `pnpm run ci` green locally before you push. No skipped tests, no
  lowered coverage thresholds.
- New behaviour comes with tests — this codebase pins invariants (event
  ownership, tool allow-lists, i18n parity, doc-twin integrity) with
  file-reading guard tests that include self-checks, so a silently broken
  regex cannot pass. Follow that pattern.
- Keep diffs minimal and on one topic; the repo works in tracks, not
  omnibus PRs.

## Language policy

- **Code, comments, commit messages, and everything model-facing** (tool
  descriptions, contracts, orchestrator/role prompts) are **English**.
- **Documentation is English-canonical with maintained German twins**: the
  canonical file is English-named and English-language, and its German twin
  sits beside it as `<NAME>.de.md`. Both start with a language-switch line.
  Whoever touches a canonical doc updates its twin in the same PR —
  `scripts/docsTwins.test.ts` enforces matching heading trees and link
  targets, and fails on German copy left in an English canonical.
- **UI strings** never live inline; they go through the three i18n layers:
  the renderer's i18next bundles (`src/renderer/src/i18n/locales/de.json` /
  `en.json`, guarded for key parity, dead keys and untranslated copy by
  `i18n.test.ts`), the main-process message table
  (`src/shared/mainMessages.ts`) for native dialogs and errors that travel
  through IPC where no `t()` runs, and the remote web client's bundle
  (`src/remoteClient/i18n.ts`), which follows the `hello.locale` the
  gateway sends. Add every new string to both locales of the right layer.

## Versioning and releases

Vertragus ships two update channels from one repository: every green build of
`main` becomes a prerelease on the `main` channel, and a pushed `vX.Y.0` tag
becomes a normal release on `latest`. An installation follows exactly one of
them (`applyChannel` in `src/main/updater.ts`), so they never see each other's
builds.

The `version` in `package.json` is a **patch base**, not a count: the release
workflow ADDS the run number to the patch, so a committed `1.1.0` produces
main builds `1.1.<run>-main.<attempt>.g<sha>`. Two rules follow, and
`scripts/release-version.mjs` enforces the first of them on every pushed tag:

- Committed versions are always `X.Y.0`; releases are tagged `vX.Y.0`, and the
  tag must equal the `package.json` version, because the artifacts and
  `latest.yml` are named from `package.json`, not from the tag.
- Right after a release, main is bumped to `X.(Y+1).0`. Its prereleases then
  sort above the freshly released stable — intended and harmless, because the
  CHANNEL keeps the audiences apart, not the version order. Do not merge the
  channels to "fix" the overlap.

The full procedure, step by step and marked human vs. automated, is in
[`docs/RELEASE-CHECKLIST.md`](docs/RELEASE-CHECKLIST.md).

## Security

Do not report vulnerabilities in public issues — see
[`SECURITY.md`](SECURITY.md).
