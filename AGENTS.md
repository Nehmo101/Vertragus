English | [Deutsch](AGENTS.de.md)

# Guide for coding agents

Vertragus is an Electron panel that orchestrates AI coding agent CLIs over
an in-app MCP server. Read `README.md` for the product;
`docs/HANDBOOK-HARNESS.md` is the code-grounded map of the harness core.

## Layout

- `src/main/` — Electron main process: `workspace/` (Workspace,
  WorkspaceManager — PTYs, worktrees, events), `mcp/` (server, tools,
  event queue, questions, attach dialects, `/browser` bridge),
  `browserExtension/` (pairing IPC), `providers/` (presets, CLI-recorded
  usage), `remote/`
  (Tailscale gateway), `windows/`, `store/`, `appIpc.ts`.
- `src/shared/` — schemas (zod, `schema/`), prompts (`prompts/`),
  `mainMessages.ts` (main-process i18n), lore/names.
- `src/renderer/` — React panel + windows; i18next under
  `src/renderer/src/i18n/`.
- `src/remoteClient/` — the phone web client (own tiny i18n bundle).
- `extensions/chromium/` — unpacked MV3 that pairs with `/browser`.
- `tests/integration/`, `tests/live/` — full MCP loop over real HTTP,
  orchestration over real git; live tests gated by `VERTRAGUS_LIVE=1`.
- `scripts/` — icons, panel smoke, and guard tests; `docs/` — handbook and
  plans, English-canonical with German `.de.md` twins.

## Verify

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run ci   # lint + typecheck node/web + all tests + both builds
```

`pnpm run ci` green is the definition of done. Coverage is a ratchet
(`vitest.config.ts`) — never lower thresholds. Tests sit next to their
subject (`foo.test.ts` beside `foo.ts`).

## Conventions

- Everything in code is English: comments, tool descriptions, contracts,
  prompts. UI strings go through the i18n layers (renderer i18next de+en,
  `src/shared/mainMessages.ts`, `src/remoteClient/i18n.ts`) — always both
  locales.
- Docs are English-canonical; every canonical doc has a German `.de.md`
  twin with the same heading structure and link targets. Touch a doc →
  update its twin in the same change. `scripts/docsTwins.test.ts` enforces
  this.
- Invariant-test culture: cross-cutting rules are pinned by file-reading
  guard tests with self-checks (e.g. `i18n.test.ts`, security contracts,
  docsTwins). When you add an invariant, add a guard that would fail loudly
  if its own scanning broke.
- Respect the doctrine in the handbook's non-goals: one host path per
  concern, no peer-to-peer agents, no autodelete, no RAG, host truth over
  agent prose, allow-lists stay minimal.
- Keep diffs small and single-topic; reference the handbook track you are
  implementing.
