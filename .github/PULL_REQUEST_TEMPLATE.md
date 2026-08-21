<!--
Delete the sections that do not apply. The release tables at the bottom are
only for a release PR — every other PR removes them.
-->

## What

<!-- One paragraph: what this changes, in the reader's terms. -->

## Why

<!-- The problem, not the patch. Link the issue if there is one. -->

## Verification

- [ ] `pnpm run ci` green locally (lint, both typechecks, tests, both builds).
- [ ] New behaviour has tests; no test skipped and no coverage threshold
      lowered (`vitest.config.ts` thresholds only ever move up).
- [ ] Docs touched in both languages where a canonical changed
      (`scripts/docsTwins.test.ts` enforces matching heading trees and links).
- [ ] New user-facing strings added to both locales of the right i18n layer.

<!-- How you checked it by hand, if that is part of the story. -->

---

<!--
RELEASE PR ONLY — everything below.
The full procedure is in ../docs/RELEASE-CHECKLIST.md; these tables are the
record that survives with the release, which is why they are pasted here.
A release PR also carries the package.json version bump (X.Y.0) and the
changelog cut in BOTH CHANGELOG.md and CHANGELOG.de.md.
-->

## Release: version and changelog

- [ ] `package.json` is `X.Y.0` (patch base — see
      [the versioning section](../docs/RELEASE-CHECKLIST.md)).
- [ ] `## [Unreleased]` cut to `## [X.Y.0] — YYYY-MM-DD` in `CHANGELOG.md`
      *and* `CHANGELOG.de.md`.
- [ ] `MCP_SERVER_VERSION` bumped **iff** the MCP tool surface changed
      (tool added/removed, argument or event semantics changed).
- [ ] `PRESET_VERIFICATION` (`src/shared/presetVerification.ts`) matches the
      CLI versions actually probed below, including `verifiedAt`.

## Release: automated gates

- [ ] Full CI green on this PR head (all three platforms, coverage ratchet,
      panel smoke, packaging).
- [ ] **Provider matrix** workflow dispatched against this head and its
      summary table reviewed. "not installed" rows are acceptable; unexplained
      `spawn no` / `keyboard no` rows are blockers.

## Release: live probe (Tier 3)

```
VERTRAGUS_LIVE=1 VERTRAGUS_LIVE_PROVIDERS=claude,codex,kimi,cursor,grok,ollama \
  pnpm vitest run tests/live/handover.live.test.ts
```

| Provider | CLI version | Seed ok | MCP report ok | Date | Tester |
| --- | --- | --- | --- | --- | --- |
| claude |  |  |  |  |  |
| codex |  |  |  |  |  |
| kimi |  |  |  |  |  |
| cursor |  |  |  |  |  |
| grok |  |  |  |  |  |
| ollama |  |  | n/a (sentinel) |  |  |

## Release: signing

| Check | Result | Date | Tester |
| --- | --- | --- | --- |
| Windows installer signature |  |  |  |
| macOS notarization/staple |  |  |  |

If signing is not enabled for this release, say so explicitly here and in the
release notes — an empty row is not an answer.
