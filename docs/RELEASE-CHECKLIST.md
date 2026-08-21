# Release Checklist

The Tier-3 gate of the provider matrix (see the WP-6 roadmap entry): the two
automated tiers prove that presets *compose* correctly (argv snapshots in
`src/main/providers/presets.matrix.test.ts`, on every push) and that the CLIs
*install, spawn and listen* (`.github/workflows/provider-matrix.yml`, weekly).
Neither proves that a real, logged-in CLI **executes an assignment and reports
back** — that is a human-run step with real accounts and real model tokens, and
it happens here, before every tagged release.

A release tag requires every step checked and the provider table filled in.
Copy this file's tables into the release PR description (or link a filled copy)
so the record survives with the release.

## 1. Automated gates

- [ ] `pnpm run ci` is green locally (lint, both typechecks, all tests, both
      builds) on the commit to be tagged.
- [ ] The **Provider matrix** workflow was dispatched against that commit
      (`gh workflow run provider-matrix.yml` or the Actions tab → *Provider
      matrix* → *Run workflow*) and its summary table was reviewed. "not
      installed" rows for CLIs the runner cannot install are acceptable;
      unexplained `spawn no` / `keyboard no` rows are release blockers until
      understood.
- [ ] No preset argv snapshot changed since the last release without a matching
      entry in the verification table below (a snapshot diff in
      `presets.matrix.test.ts` means a launch recipe changed — reverify that
      provider live).

## 2. Live probe — per provider

Run the live handover probe against every provider, with the CLIs installed and
logged in on the release machine:

```
VERTRAGUS_LIVE=1 VERTRAGUS_LIVE_PROVIDERS=claude,codex,kimi,cursor,grok,ollama \
  pnpm vitest run tests/live/handover.live.test.ts
```

This is the only tier that proves execution: a real spawn, the real seed
handshake, and a report the agent can only produce by reading its assignment to
the end (see the header of `tests/live/handover.live.test.ts`). It costs real
model tokens. Providers may be probed in smaller batches
(`VERTRAGUS_LIVE_PROVIDERS=claude,codex`, …) as long as every row below ends up
filled.

Fill one row per provider. *Seed ok* = the assignment arrived and was submitted
(the probe's handover token came back). *MCP report ok* = the agent reported
through its Vertragus MCP tools where the preset attaches them (`report_done`);
for `ollama` (MCP kind `none`) the sentinel line counts — write "n/a (sentinel)".
If a preset's installed CLI version differs from `PRESET_VERIFICATION`
(`src/shared/presetVerification.ts`), update the map — and its `verifiedAt` —
in the same release PR.

| Provider | CLI version | Seed ok | MCP report ok | Date | Tester |
| --- | --- | --- | --- | --- | --- |
| claude |  |  |  |  |  |
| codex |  |  |  |  |  |
| kimi |  |  |  |  |  |
| cursor |  |  |  |  |  |
| grok |  |  |  |  |  |
| ollama |  |  | n/a (sentinel) |  |  |

## 3. Signing verification

- [ ] Installer signatures verified per [docs/SIGNING.md](SIGNING.md)
      (Windows: `Get-AuthenticodeSignature` on the `.exe`; macOS: `spctl -a -vv`
      and `xcrun stapler validate` on the app). If signing is not yet enabled
      for this release, record that explicitly in the release notes instead of
      skipping the row silently.

| Check | Result | Date | Tester |
| --- | --- | --- | --- |
| Windows installer signature |  |  |  |
| macOS notarization/staple |  |  |  |

## 4. Versioning

Vertragus ships two update channels from one repository, and they never see
each other's builds (`applyChannel` in `src/main/updater.ts`): an installation
on `main` reads `main*.yml` and gets every green build of the branch; an
installation on `latest` reads `latest*.yml` and only ever gets tags.

The version in `package.json` is a **patch base**, not a count. `release.yml`
derives a main-channel prerelease by ADDING the run number to the patch, so
committed `1.1.0` yields `1.1.<runNumber>-main.<attempt>.g<sha>`. That has one
consequence worth writing down, because it looks like a bug:

> After tagging `1.0.0`, main-channel prereleases are `1.1.<run>-main…`, which
> sort **above** the released `1.0.0`. This is intended. The channels — not the
> version order — keep the two audiences apart: a stable installation resolves
> `latest.yml` and never learns that a higher prerelease exists. Do not "fix"
> the overlap by merging the channels or by moving stable onto prerelease
> numbering; that is what would actually push untested builds onto stable
> users.

The convention, therefore:

- Release **`X.Y.0`** — the patch of a committed version is always `0`.
  `scripts/release-version.mjs` refuses any tag whose package version is not
  `X.Y.0`, and `scripts/releaseVersion.test.ts` asserts the shape against the
  real `package.json` on every CI run.
- Immediately after a release, open a **"Back to development" PR** that sets
  `package.json` to `X.(Y+1).0` and starts a fresh `## [Unreleased]` block in
  both changelogs. Main then builds `X.(Y+1).<run>-main…` again.
- A patch release for a shipped `X.Y.0` is `X.(Y+1).0` too — the second number
  carries all normal releases, the third is reserved for the run arithmetic.
- The MCP tool-contract version (`MCP_SERVER_VERSION` in
  `src/main/mcp/server.ts`) is **independent** of the app version: it is what
  agent CLIs receive in the handshake, and it moves only when the tool surface
  moves.

- [ ] If the MCP tool surface changed since the last release (a tool added or
      removed, an argument or an event semantic changed), `MCP_SERVER_VERSION`
      was bumped and the change is noted in the changelog. If it did not
      change, leave the constant alone — an unchanged contract must not appear
      to have changed.

## 5. Tag and publish — the runbook

Each step is marked **[human]** or **[automated]**. Nothing here is optional:
the guard in step 5 exists because the failure it prevents (a release whose
artifacts and `latest.yml` carry a different version than the tag) cannot be
repaired after publication, only outgrown.

- [ ] `PRESET_VERIFICATION` matches what was actually probed above.
- [ ] Every table above is complete.

1. **[human]** Open the **release PR**. It carries all three: the
   `package.json` version bump to `X.Y.0`, the changelog cut (`## [Unreleased]`
   becomes `## [X.Y.0] — YYYY-MM-DD` in `CHANGELOG.md` *and* `CHANGELOG.de.md`),
   and the filled provider/signing tables from sections 2 and 3 pasted into the
   PR description.
2. **[automated]** PR CI runs the full gate on that commit: `pnpm run ci` on
   Windows, Linux and macOS, the coverage ratchet, the panel smoke on all
   three, and a packaging job per platform.
3. **[human]** Dispatch the **Provider matrix** workflow against the PR head
   and run the **live probe** with six logged-in CLIs (section 2). Fill every
   row. This is the only tier that proves a real agent executes an assignment.
4. **[human]** Merge the PR, then tag the merge commit and push the tag:
   `git tag vX.Y.0 && git push origin vX.Y.0`. Tag the commit that CI was
   green on — never a local commit that was never pushed.
5. **[automated]** `release.yml`'s **`guard`** job runs first, before any
   release object exists: `scripts/release-version.mjs` asserts the tag is
   `vX.Y.Z` with no prerelease suffix, that `X.Y.Z` equals the `package.json`
   version, and that the patch is `0`. A mismatch fails here — no release, no
   artifacts, and the fix is a one-line PR plus a re-pushed tag.
6. **[automated]** `ci.yml` runs the same full gate on the tag (it triggers on
   `tags: ['v*']`; only its packaging job is skipped, because `release.yml`
   packages the same commit anyway).
7. **[automated]** `release.yml` builds the installers on all three platforms
   and uploads them into a **draft** release. Tag releases stay drafts on
   purpose: the `publish` job that flips a release visible only runs for
   pushes to `main` (the `main` prereleases), never for tags.
8. **[human]** Verify the draft before publishing it:
   - the installer file names carry `X.Y.0` (`Vertragus-X.Y.0-setup.exe`), not
     the previous version;
   - `latest.yml` (and `latest-mac.yml` / `latest-linux.yml`, where present)
     names `X.Y.0` — this file is what every installed stable app compares
     itself against;
   - every expected platform's artifacts are attached;
   - signatures verified per section 3, **or** an explicit "unsigned by
     choice" note in the release body. Silence is not an acceptable answer
     here.
9. **[human]** Publish the draft, and paste the release notes from
   `CHANGELOG.md`.
10. **[human]** Open the **"Back to development: X.(Y+1).0"** PR immediately
    (see section 4). Until it merges, main builds keep deriving from the
    released base.
11. **[human]** Post-publish check, on a real installation: install `X.Y.0`,
    set the update channel to `latest` — it must report **no update
    available**. Switch the same installation to `main` — it must see
    `X.(Y+1).<run>-main…` and offer it. That single pair of observations
    proves both channels resolve, and that the overlap described in section 4
    is doing what it is supposed to do.
