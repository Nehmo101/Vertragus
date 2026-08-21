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

## 4. Tag

- [ ] `PRESET_VERIFICATION` matches what was actually probed above.
- [ ] Both tables above are complete.
- [ ] Tag and push; the release workflow publishes from `main` only.
