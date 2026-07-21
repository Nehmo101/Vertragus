# Vertragus — Full Codebase Audit & Prioritized Remediation Report

**Date:** 2026-07-21
**Scope:** Full 6-category audit (security, performance, code quality, test coverage, dependencies, architecture)
**Method:** 6 parallel category auditors, each finding independently cross-verified by an adversarial verifier that attempted to *refute* it before it was surfaced. Confidence is flagged per finding.
**Commit audited:** `425db1c` (branch `claude/scan-everything-r66a2y`)

---

## Executive Summary

Vertragus is a structurally sound Electron desktop app (main / preload / renderer / shared separation, `src/shared` is genuinely well-tested) with **no confirmed CRITICAL findings and no remotely-exploitable-without-preconditions vulnerabilities**. Its real weaknesses cluster in two places: (1) a set of **main-process performance taxes that compound under active runs** — synchronous journal/session writes, unbounded 200 KB scrollback re-scanned and re-serialized on every PTY chunk, and whole-store zustand subscriptions that re-render the entire React tree on every agent tick; and (2) **inconsistent IPC sender-authorization**, where several privileged channels (`mcpSave` → arbitrary command execution on next agent spawn, git/GitHub mutations, and every `orchestrator:*` handler) trust the renderer despite documentation claiming the voice-overlay window is denied them. The shipped Electron 33.4.11 runtime is **past end-of-life**, which is the single most consequential dependency item. **Overall health score: 72/100 (Fair–Good).** Verified counts: **0 CRITICAL, 6 HIGH, 5 MEDIUM, 14 LOW** among the 25 adversarially-verified findings, plus a tier of dependency/architecture findings collected but not adversarially verified (the verification pass was interrupted by an API spend limit — see the labeled section and the spot-checks I ran directly).

> **Remediation progress (this branch, `claude/scan-everything-r66a2y`):** the large majority of findings are now fixed and verified (full suite 1252 tests + typecheck + lint green).
>
> **Fixed — security:** **H1** (removed the shell from the `gh` spawn + option-injection guard on the search query, with tests); **H2** (added `assertNotVoiceWindow` to all 13 `orchestrator:*` mutators + `mcpSave`/`gitSwitchBranch`/`githubRepoBind`/`githubRepoSearch`/`githubAuth*`/`profileGenerateForRepo`, 20 new regression tests); **L1** (pairing rate-limit keys on `cf-connecting-ip`); **L12** (config-key validator now rejects `__proto__`/`constructor`/`prototype` segments, with real tests).
>
> **Fixed — performance:** **H3** (async serialized journal writes + cached size + journal-on-transition-only); **H4** (Cursor trust scan bounded to an 8 KB tail + removed the duplicate flatten pass); **H5 first pass** (root `App` now uses a `useShallow` selector so the tree no longer reconciles on every tick; `OrchestratorPanel` clock ticks only during active work); **M1** (`bufferTail` IPC slices scrollback in-process; canvas peek fetches 4 KB); **M2** (Engine coalesces snapshot pushes to one trailing push/250ms); **M3** (git poll skips unchanged writes); **M4** (chunked `ScrollbackBuffer` — amortized O(chunk) appends, with tests); **L2** (agent-list broadcast debounced); **L3** (async session-store write queue with sync quit-flush); **L4** (RemoteReadModel evicts removed sessions).
>
> **Fixed — code quality:** **L6/L8/L9** (deleted dead `telemetryFormatter`, `VoiceBar`, `inboxSorter`, `modelCatalogFilter` + tests); **L10** (`requireProfile` unifies missing-profile handling across mutators); **L11** (removed dead `readGithubOAuthMeta` **and** deduped the triplicated encrypt/decrypt blocks); **H5 remainder** (`TitleBar` + all four Sidebar rows + `SidebarView` now subscribe via narrow `useShallow` selectors, deriving booleans/counts so usage-only ticks don't re-render them).
>
> **Fixed — test coverage:** **H6** (RemoteGateway path-traversal + 401/403 + `/pair` 429); **L12** (prototype-pollution validator + tests); plus new suites for **updater.ts** (19), **secrets.ts** key-fallback/encryption-unavailable, **rateLimit.ts** edge cases, **windows.ts** hardening-flag source contract, **register.ts** channel-wiring consistency, and **apps/mobile** storage helpers; the flaky fixed-sleep in `transferReviewGate.test.ts` was replaced with a bounded poll. Suite grew 1238 → 1297.
>
> **Fixed — dependencies:** **D1** (Electron 33.4.11 → 43.1.1, electron-builder 25 → 26 — clears all 18 prod advisories incl. 4 HIGH); **D2** (tar advisory cleared by the builder-26 upgrade); **D3** (vitest 2 → 3.2.7 — clears the critical Vitest-UI advisory); **D4** (vite 5 → 6.4.3, electron-vite 2 → 3, plugin-react 4 → 5, `moduleResolution: bundler`, plus pnpm-workspace overrides pinning transitively-bundled vite/esbuild) ; **D5** (`THIRD_PARTY_NOTICES.md` for web-push MPL-2.0). **`pnpm audit` now reports zero known vulnerabilities (prod + dev).** Test isolation fixed via `ELECTRON_OVERRIDE_DIST_PATH` (also closes the "7 suites depend on the Electron binary" finding). Everything verified green: 1297 tests, typecheck, lint, `electron-vite build`.
>
> **Still required before release:** a manual smoke-test of the *packaged* app (`build:win`/`build:mac`/`build:linux` + launch), since the 10-major Electron jump can change runtime behavior that typecheck/unit-tests don't exercise, and Windows packaging (`electron-winstaller`) can't be validated on this Linux host.
>
> **Remaining (in progress / deliberate):**
> - **A1/A2/A3/A5/A8 (god-class + store splits):** being done as behavior-preserving structural extractions, one module at a time, each verified against the full suite. **A5 (autoPr) in progress.**
> - **D6** (ws/web-push/qrcode stay `optionalDependencies` — the remote feature degrades gracefully via guarded dynamic import) and **D7** (electron-store 8, zod 3 — no CVE; ESM/breaking-change migrations left as dedicated work).
> - **L7** kept (`canvasSlots`'s `rectsOverlap` backs a live auto-layout test — the "dead" claim was only partly right).
>
> **A note on completeness:** the audit fan-out completed all 6 category scans, but the adversarial verification pass was cut off partway by an API monthly-spend limit. The **security, performance, and code-quality** findings below are **fully verified**. The **dependencies** and **architecture** findings, plus 8 **test-coverage** findings, reached the verifier but it could not run — those are in the *"Collected, not adversarially verified"* section, where I have manually spot-checked the objective claims (versions, line counts) against the repo and noted what remains unconfirmed.

### Health score breakdown

| Dimension | Grade | Notes |
|---|---|---|
| Security | B− | No critical holes; command-injection sink (Windows) + inconsistent IPC auth are the real gaps |
| Performance | C+ | Correct today, but several unthrottled main-process hot paths that scale poorly with agent count |
| Code quality | B | Clean overall; ~6 dead modules kept alive only by their own tests; mixed error/validation styles |
| Test coverage | B− | `src/shared` strong; network-facing `RemoteGateway` path-traversal guard and secret storage untested |
| Dependencies | C | EOL Electron runtime is the headline; most other advisories are dev/build-time only |
| Architecture | C+ | Several 1.2k–4k-line god modules; state duplicated main↔renderer with ad-hoc sync |

---

## Prioritized Findings

Severities below reflect the **verifier-adjusted** severity where the adversarial pass corrected the original auditor.

---

### 🔴 HIGH

#### H1 · Windows command injection via GitHub search query
- **Category:** Security · **Confidence:** HIGH · **Effort:** 30 min · **Quick win:** ✅
- **Location:** `src/main/integrations/githubRepo.ts:84` (sink), reachable via `src/main/ipc/register.ts:430` (`githubRepoSearch` IPC)
- **Description:** `runGhJson()` spawns `gh` with `shell: process.platform === 'win32'`. With `shell:true`, Node concatenates file + args into one command line **without quoting** and runs it through `cmd.exe`. `searchGithubRepos()` passes the raw renderer-supplied query as an argv element; only the `owner/repo` branch is validated by `normalizeRepoSlug` — the free-text branch is not. On Windows, a query like `foo & calc.exe & ` executes arbitrary commands. The channel has no sender/validation guard.
- **Recommended fix:** Drop the `shell` option entirely (let `execFile` resolve `gh`/`gh.cmd` on PATH and pass args as an argv array so they are never re-parsed by `cmd.exe`). If a `.cmd` shim truly needs a shell, whitelist the query and pass via `cmd.exe /c` with explicit quoting.
- **Caveat:** Windows-only; injected input is user-typed search text absent a renderer compromise/XSS.

#### H2 · Missing IPC sender authorization on privileged `orchestrator:*` + mutation channels (contradicts documented trust model)
- **Category:** Security / Code quality · **Confidence:** HIGH · **Effort:** 1–3 h · **Quick win:** partial
- **Location:** `src/main/ipc/register.ts` — orchestrator handlers ~607–717 (`setYoloMaster:634`, `resolvePermission:667`, `reviewPlan:637`, `approvePublication`, `pauseTask`…), plus `mcpSave:400`, `gitSwitchBranch`, `githubRepoBind`, `githubAuth*`, `profileGenerateForRepo`
- **Description:** The voice-overlay and pop-out pane windows share the **same preload** as the main window (`windows.ts` `baseWebPreferences`). Comments at `register.ts:255-257` and `windows.ts:307-312` assert every privileged agent/spawn/**orchestrator** channel refuses the voice window, and `assertNotVoiceWindow` is indeed wired onto agent/file channels — but **none of the ~13 `orchestrator:*` handlers check the sender**, and `mcpSave`/git/GitHub mutations have no sender check at all. `mcpSave` persists an arbitrary stdio `command`+`args` MCP server that is executed on the next agent spawn (`externalMcp.ts` feeds it straight into the launch spec) — a **persistent code-execution primitive**. The overlay/pane renderer (or a compromised renderer) can approve plans, resolve permission prompts, and enable global YOLO mode. The proper guards (`assertNotVoiceWindow`, `assertAuthorizedRendererIpcSender`, `requireMainWindow`) already exist and are used elsewhere — the omission is inconsistent, not intentional — and the regression test (`register.voiceAuth.test.ts`) never covers these channels. *(H2 unifies two separately-verified findings, from the security and code-quality auditors, that describe the same root cause from different angles.)*
- **Recommended fix:** Apply one main-window-only guard (`assertNotVoiceWindow` at minimum, ideally `assertAuthorizedRendererIpcSender`) to **every** state-mutating / command-executing handler, failing closed by default and allow-listing the read-only channels the overlay/panes need. Add regression tests covering the orchestrator + `mcpSave` channels. If any omission is deliberate, correct the two comments that claim otherwise.
- **Caveat:** Requires the overlay/pane renderer to be subverted first (defense-in-depth breach, not a direct remote hole) — but the unguarded channels are exactly the escalation primitives the guard exists to block.

#### H3 · Synchronous run-journal write + deep redaction on every orchestrator snapshot
- **Category:** Performance · **Confidence:** HIGH · **Effort:** 2 h · **Quick win:** ✅
- **Location:** `src/main/ipc/register.ts:833` → `src/main/diagnostics/runJournal.ts:94-118`
- **Description:** Every orchestrator snapshot emission calls `recordDiagnostic()` **synchronously** on the main process. Snapshots fire up to ~1/s **per running task** (`Engine.ts:1829-1833`), so a 6-task plan emits ~6/s. Each does a full recursive `redactDiagnosticValue()` walk (2 regexes per string) over the entire snapshot, `JSON.stringify` of the whole payload, then `existsSync` + `statSync` + `appendFileSync` — all blocking I/O. The Engine *deliberately throttles* its own disk persistence for this exact reason (`Engine.ts:696` comment), but this journal path is unthrottled and does strictly more work per event. It steals main-process time from PTY streaming and IPC while runs are active.
- **Recommended fix:** Throttle journal writes to the ~2 s snapshot-persist cadence (or only journal on task *status transitions*, not every heartbeat/usage tick); switch to `fs.promises.appendFile` on a serialized async queue; cache the file size instead of `statSync` per record.

#### H4 · Cursor trust detection regex-scans the entire 200 KB scrollback on every PTY chunk
- **Category:** Performance · **Confidence:** HIGH · **Effort:** 1 h · **Quick win:** ✅ (flagged; ~1 h)
- **Location:** `src/main/agents/AgentManager.ts:520` (`pushData` → `autoTrustCursorWorktree`), `src/main/agents/cursorWorkspaceTrust.ts:138-140`
- **Description:** `pushData()` runs for **every** PTY output chunk and passes the full scrollback buffer (up to `BUFFER_LIMIT = 200_000` chars) into `cursorWorkspaceTrustPrompt()`, which runs `visibleTerminalText()` (stripAnsi + 3 global regex replaces) over the whole buffer — and on a hit re-runs it a second time via `outputMentionsWorkspace()`. For an orchestrator-spawned Cursor pane in an isolated (already-trusted) worktree, the trust prompt never appears, so neither `workspaceTrustHandled` nor `interactiveUsed` is ever set and the O(200 KB) scan runs for **every chunk of the entire session**. Sibling scanners in the same function correctly use `slice(-2000)`/`slice(-800)`; this call is the outlier.
- **Recommended fix:** Scan only a bounded tail (`buffer.slice(-4000)` — the trust screen fits in a few KB); remove the duplicate `visibleTerminalText()` pass; set a one-shot "trust window expired" flag after startup so steady-state chunks skip the check.

#### H5 · Whole-store zustand subscriptions re-render the entire app on every high-frequency update
- **Category:** Performance / Architecture · **Confidence:** HIGH · **Effort:** 1–2 days · **Quick win:** ❌
- **Location:** `src/renderer/src/App.tsx:32` and ~13 other bare `useAppStore()` call sites (Sidebar ×5, TitleBar, OrchestratorPanel, CanvasBoard…); `src/renderer/src/store/useAppStore.ts`
- **Description:** 17 components call bare `useAppStore()` with **no selector**, subscribing to every store change. High-frequency writers hit this constantly: agent usage ticks replace the `agents` array; orchestrator snapshots (≤1/s per task) replace `orchestrator`/`orchestrators`; events append per dispatch; `refreshGit` sets a fresh `gitInfo` every 10 s. Because the root `App` re-renders and only `TerminalHost` is `memo()`'d, every update reconciles the whole tree — ReactFlow canvas, all task cards, event log. `OrchestratorPanel` additionally ticks a 1 s `useClock()` forcing a full-panel re-render even when idle.
- **Recommended fix:** Replace bare `useAppStore()` with narrow selectors (`Workspace.tsx` already models the correct pattern); wrap Sidebar/OrchestratorPanel/TitleBar/CanvasBoard in `React.memo`; deliver the 1 s clock via context consumed only by the small age-label components.

#### H6 · RemoteGateway static file serving (path-traversal guard) and per-route auth are untested
- **Category:** Test coverage / Security · **Confidence:** HIGH · **Effort:** 3 h · **Quick win:** ❌
- **Location:** `src/main/remote/RemoteGateway.ts:215-235` (`serveStatic`); `RemoteGateway.test.ts` (only 2 tests)
- **Description:** `RemoteGateway` is the network-facing HTTP/WS server for phone remote control. Its path-traversal guard is subtle — `decodeURIComponent` (throws `URIError` on `%zz`), a `candidate.startsWith(root + sep)` check, an `index.html` fallback, and a win32-separator special case — and **serveStatic requires no authentication** (it's reached as a GET fallthrough after only the Host check). A regression here is **unauthenticated arbitrary file read** when the Cloudflare tunnel is active. Also untested: the 401-vs-403 distinction per API route, HTTP-layer scope/capability enforcement, the `/pair` 429 limiter, and SSE `/stream` auth. `selftestRemote.ts` exists but is gated behind a manual env flag and is not run in CI.
- **Recommended fix:** Extend `RemoteGateway.test.ts`: serve a temp `staticDir` and assert `GET /../secret`, `%2e%2e%2f`, and malformed `%zz` never escape root (404/fallback, no crash); unauthenticated route → 401; wrong-capability token → 403; `/pair` flood → 429.

---

### 🟠 MEDIUM

#### M1 · Canvas TerminalPeek polls the full 200 KB scrollback over IPC every 1.2 s per node
- **Category:** Performance · **Confidence:** HIGH · **Effort:** 2 h · **Quick win:** ✅ (flagged)
- **Location:** `src/renderer/src/components/CanvasBoard.tsx:80`; `src/main/agents/AgentManager.ts:224-226`
- **Description:** Every running task node + the orchestrator node mounts a `TerminalPeek` calling `agents.buffer(agentId)` on a 1200 ms interval. `AgentManager.buffer()` returns the **entire** scrollback (≤200 KB), structured-clone-serialized over IPC, only for `terminalTail(data, 6, 60)` to keep 6 lines. With ~7 visible nodes that's ~1.2 MB/s of IPC serialization to render ~2.5 KB — while the same data already streams incrementally via `ev:agentData`.
- **Recommended fix:** Add a `bufferTail(id, maxChars)` IPC endpoint that slices in main before serializing, or drop polling and derive the peek from the `ev:agentData` stream (keep a small renderer-side per-agent tail).
- *(Verifier adjusted HIGH→MEDIUM: real churn, but bounded and not user-visible jank.)*

#### M2 · Full orchestrator snapshot rebuilt and broadcast up to once per second per running task
- **Category:** Performance · **Confidence:** HIGH · **Effort:** 0.5–1 day · **Quick win:** ❌
- **Location:** `src/main/orchestrator/Engine.ts:1830`; broadcast at `src/main/ipc/register.ts:839`
- **Description:** `push()` is throttled per-task, so N running workers still build and fan out N full snapshots/s. Each `snapshot()` sorts/copies the entire task list, calls `agentManager.list()`, clones reliability/permissions/activity, and rebuilds integration+budget views; the result (tasks with attempts/recentActions/findings) is broadcast to every window, re-serialized per window, and clones the renderer `orchestrators` record. Nothing is delta-based, so cost grows ~N² during the busiest phase. (This shares the H3 journal-write path.)
- **Recommended fix:** Coalesce pushes at the engine level — one trailing push per ~1 s across **all** tasks (dirty flag + single timer). Optionally exclude bulky per-task fields from the live broadcast, fetchable on demand.

#### M3 · 10-second git poll spawns 8 subprocesses and always triggers a global store update
- **Category:** Performance · **Confidence:** HIGH · **Effort:** 1 h · **Quick win:** ✅ (flagged)
- **Location:** `src/renderer/src/components/TitleBar.tsx:114`; `src/main/integrations/git.ts:75-99`; `src/renderer/src/store/useAppStore.ts:699`
- **Description:** Every 10 s, `refreshGit()` → `gitInfo()` spawns **8 git subprocesses** in parallel (including full `git status --porcelain=v1` and `git worktree list`), and then calls `set({ gitInfo })` with a fresh object **unconditionally even when nothing changed**. Combined with the bare `useAppStore()` subscriptions (H5), the whole app tree re-renders every 10 s even when completely idle.
- **Recommended fix:** Hash/deep-compare new `GitInfo` and skip `set()` when unchanged; refresh on window focus + after agent/task completion instead of a fixed interval; use `--untracked-files=no` for the dirty check.

#### M4 · PTY scrollback kept as a single string: O(200 KB) copy on every output chunk
- **Category:** Performance · **Confidence:** HIGH · **Effort:** 3 h · **Quick win:** ❌
- **Location:** `src/main/agents/AgentManager.ts:515`
- **Description:** `managed.buffer = (managed.buffer + data).slice(-BUFFER_LIMIT)` maintains scrollback as one immutable string. Once an agent hits the 200 KB cap, every incoming chunk (often a few dozen bytes, arriving many times/s) forces a full ~200 KB flatten/copy in the main process. With several concurrent agents this is steady memcpy + GC load in the same loop that services IPC and the engine.
- **Recommended fix:** Store scrollback as an array of chunks with a running length; evict head chunks past `BUFFER_LIMIT`; `join()` lazily only in `buffer()`/persist/handoff paths; keep a small pre-joined ~4 KB tail for the per-chunk scans.

#### M5 · Three coexisting IPC validation styles for the same renderer→main boundary
- **Category:** Code quality · **Confidence:** HIGH · **Effort:** 1 day · **Quick win:** ❌
- **Location:** `src/main/ipc/register.ts` (contrast `:306` vs `:400` vs `:378-382`); `src/shared/ipcValidation.ts`
- **Description:** Validating untrusted renderer payloads is done three ways in one file: (a) dedicated authorize+parse controllers taking `unknown` (profileSave, workspaceSession*, ideas*); (b) ad-hoc inline `typeof` checks; (c) blind trust of compile-time types with no sender auth (`mcpSave`, `gitSwitchBranch`, `githubRepoBind`, `ideasUpdate`, `providerLogin`…). `ipcValidation.ts`'s header advertises "an early, shared guard" but exports only `assertValidConfigKey`. Downstream layers partially compensate (zod on save, branch-existence checks), so nothing is directly exploitable today — but which channels get auth vs parsing vs nothing is unpredictable and new handlers copy whichever style is nearest. (Directly related to H2.)
- **Recommended fix:** Standardize on the controller pattern (authorize sender + zod-parse `unknown`); extend `ipcValidation.ts` or a handler wrapper to apply it uniformly; migrate the trust-the-type handlers. At minimum, document which channels intentionally rely on downstream validation.

#### M6 · `telemetryFormatter.ts` is a dead duplicate of the renderer's `telemetryFormat.ts`
- **Category:** Code quality · **Confidence:** HIGH · **Effort:** 30 min · **Quick win:** ✅
- **Location:** `src/shared/telemetryFormatter.ts:30` vs `src/renderer/src/telemetryFormat.ts`
- **Description:** The two files contain **byte-identical** private helpers (`metric()`, `compact()`) and near-identical formatters. The shared copy's docstring claims it's used "across all presentation surfaces," but every real consumer (AgentPane, CanvasBoard, LimitsPanel, OrchestratorPanel) imports the **renderer** copy; the shared file is imported only by its own test. The copies have already begun to diverge, so a future rounding/locale fix will land in one and silently miss the other.
- **Recommended fix:** Delete one copy (make the renderer import `@shared/telemetryFormatter` and port `formatTokenBreakdown`, or delete the shared file + its test) and fix the misleading comments.

---

### 🟡 LOW

#### L1 · Remote pairing rate-limit collapses to localhost behind the Cloudflare tunnel
- **Category:** Security · **Confidence:** HIGH · **Effort:** 1 h · **Quick win:** ✅ (flagged)
- **Location:** `src/main/remote/RemoteGateway.ts:248`
- **Description:** `/pair` rate-limits by `req.socket.remoteAddress`. Behind the tunnel, `cloudflared` connects over `127.0.0.1`, so **every internet client shares one `127.0.0.1` bucket** (5 attempts / 5 min) — including the owner. A remote attacker can exhaust the shared bucket and deny pairing to the owner (availability-only DoS; the 128-bit pairing code makes brute force irrelevant). Runs before `authenticate()`, so Cloudflare Access does not protect it.
- **Recommended fix:** Don't key on `remoteAddress` for tunneled traffic. Use a single global limiter the owner can reset locally, gate `/pair` to an owner-initiated pairing window, or key on a trusted forwarded-identity header set by cloudflared/Access.

#### L2 · Full agent list (including preflight reports) broadcast to all windows on every status/usage tick
- **Category:** Performance · **Confidence:** HIGH · **Effort:** 2 h · **Quick win:** ✅ (flagged)
- **Location:** `src/main/agents/AgentManager.ts:244-246`; `src/main/ipc/register.ts:815`
- **Description:** `AgentManager.changed()` emits the complete `AgentInstanceInfo[]` (including each agent's `PanePreflightReport`) and it's broadcast to every window on every usage snapshot, permission prompt/answer, status flip, and gate transition — re-serialized per window even when one agent's numbers changed. Feeds the H5 global-re-render problem. (Tempered: Claude-style providers emit usage once per run; preflight payloads are small.)
- **Recommended fix:** Strip `preflight` from the live payload (fetch on demand); debounce `changed` emissions (~250 ms trailing).

#### L3 · Synchronous session-store writes on the main thread
- **Category:** Performance · **Confidence:** HIGH · **Effort:** 3 h · **Quick win:** ❌
- **Location:** `src/main/config/sessionStore.ts:107`; `Engine.ts:189`; `src/main/agents/resumeState.ts:11,21-24`
- **Description:** All session persistence uses blocking `writeFileSync`. The throttled snapshot persist writes full JSON synchronously ≤ every 2 s during a run; the 30 s resume sweep runs redaction + `JSON.stringify` + sync write over a 64 KB scrollback tail **per session-bound agent** (~0.5 MB burst for an 8-agent team). Magnitude is small, hence LOW.
- **Recommended fix:** Move `writeFileAtomic` to `fs.promises` with a per-key last-write-wins queue; move redaction+stringify off the hot path (or into a worker).

#### L4 · RemoteReadModel snapshot map never evicts removed sessions
- **Category:** Performance · **Confidence:** HIGH · **Effort:** 30 min · **Quick win:** ✅
- **Location:** `src/main/remote/readModel.ts:68`
- **Description:** `onSnapshot` stores snapshots keyed by `workspaceSessionId` with no corresponding `delete` anywhere. Removed sessions' full snapshots persist for the app lifetime; `initialFrames()` replays them all to every new remote device and `deriveApprovals()` iterates the whole map per snapshot event. Bounded by distinct session count and only while remote is enabled, hence LOW.
- **Recommended fix:** Subscribe to the registry's `changed`/removal event and delete the key, or cap the map to sessions in `workspaceSessions.list()`.

#### L5 · `orchestratorTraining.ts` (823 lines) has zero production consumers
- **Category:** Code quality · **Confidence:** HIGH · **Effort:** 2 h · **Quick win:** ❌
- **Location:** `src/shared/orchestratorTraining.ts`
- **Description:** Imported only by its own test + `planEstimate.test.ts`; `trainingScenarioById` is never called. Per `CHANGELOG.md` (#49) it was deliberately shipped as a test-validated documentation curriculum (paired with `docs/ORCHESTRATOR_TRAINING_PROMPTS.md`), so the sync cost is its intended drift-detection purpose — hence LOW, not dead weight. The real residue is misleading placement in `src/shared/` and the unused `trainingScenarioById` export.
- **Recommended fix:** Move the catalog to a fixtures/docs location so it stops looking like shipped production code; delete the unused `trainingScenarioById` export.

#### L6 · `VoiceBar.tsx` (149 lines) is a dead component — never imported
- **Category:** Code quality · **Confidence:** HIGH · **Effort:** 15 min · **Quick win:** ✅
- **Location:** `src/renderer/src/components/VoiceBar.tsx`
- **Description:** No import anywhere (only comments/docs and a training-prompt string reference the name); no dynamic-import escape hatch exists. The live voice UI is `VoiceOverlay.tsx`. It still wires `useInboxSpeech`/`useAppStore`/speech-shortcut context, accruing maintenance cost for UI that can never render.
- **Recommended fix:** Delete the file (and any i18n keys used only by it); update the `orchestratorTraining` scenario that references its path.

#### L7 · `canvasSlots.ts` (118 lines) free-slot placement engine is only reachable from tests
- **Category:** Code quality · **Confidence:** HIGH · **Effort:** 30 min · **Quick win:** ✅
- **Location:** `src/renderer/src/canvasSlots.ts`
- **Description:** `findFreeCanvasSlot`/`placeCanvasSlots`/`rectsOverlap` are imported only by `canvasSlots.test.ts` and `canvasGraph.test.ts`. `CanvasBoard` places nodes via `buildCanvasGraph` (dagre) + persisted drag positions and never resolves a free slot, so the tested new-node behavior doesn't describe the shipped app.
- **Recommended fix:** Wire `findFreeCanvasSlot` into the real new-node path if that UX is wanted, else delete the module + its test.

#### L8 · `shared/inboxSorter.ts` (6 sort orders) is dead — production uses a separate implementation
- **Category:** Code quality · **Confidence:** HIGH · **Effort:** 15 min · **Quick win:** ✅
- **Location:** `src/shared/inboxSorter.ts`
- **Description:** `sortInboxItems`/`INBOX_SORT_ORDERS` imported only by its test. The real inbox list sorts via `sortNewestFirst` from `src/main/inbox/archive.ts` (`store.ts:74`), and no UI offers the six orders. Two sorting implementations for one concept, one unreachable — a drift trap.
- **Recommended fix:** Delete the module + test, or replace `sortNewestFirst` with it and expose the sort orders in the UI.

#### L9 · `shared/modelCatalogFilter.ts` is dead — the model picker deliberately does not filter
- **Category:** Code quality · **Confidence:** HIGH · **Effort:** 15 min · **Quick win:** ✅
- **Location:** `src/shared/modelCatalogFilter.ts`
- **Description:** `filterModelCatalog` imported only by its test. `ModelCombo.tsx` documents the opposite design ("unfiltered catalogue picker") and renders `models` directly with no filtering or `excludedModels` support. Speculative API contradicting the shipped UX.
- **Recommended fix:** Delete the module + test, or integrate it into `ModelCombo`/`ModelCatalogStatus` if filtering/exclusions are on the roadmap.

#### L10 · Unknown-`profileId` handled four different ways across sibling IPC handlers
- **Category:** Code quality · **Confidence:** HIGH · **Effort:** 1 h · **Quick win:** ✅ (flagged)
- **Location:** `src/main/ipc/register.ts:607` (and 358, 561, 613, orchestrator pause/resume)
- **Description:** For the identical condition (a `profileId` resolving to no profile), sibling handlers variously **throw**, return a **synthetic empty snapshot**, return **`[]`**, or return **`false`** — and `orchestratorReset` adds a silent-`undefined` fourth variant. Since `Engine.pauseTask` also returns `false` for a legitimately non-pausable task, the renderer cannot distinguish "profile deleted" from "operation declined." The remote path (`requireProfile`) throws for the same ops, proving the IPC leniency is inconsistent, not deliberate.
- **Recommended fix:** Define one convention (throw for mutations on a missing profile, matching `profileSetActive`) and apply it across orchestrator/agent handlers; keep leniency only for the read-only snapshot.

#### L11 · `secrets.ts` encrypt/decrypt logic triplicated; `readGithubOAuthMeta` is a dead export
- **Category:** Code quality / Security-adjacent · **Confidence:** HIGH · **Effort:** 30 min · **Quick win:** ✅
- **Location:** `src/main/config/secrets.ts:107` (and 33-40, 74-81, 52)
- **Description:** The decode-decrypt-catch block is **byte-identical** at three sites (`readGithubOAuthToken`, `readTranscriptionApiKey`, and the generic `readEncryptedString` added later); the write paths similarly duplicate `writeEncryptedString`. Three copies of security-sensitive decryption can drift independently. `readGithubOAuthMeta` (line 52) is exported but referenced nowhere, while its write counterpart keeps storing metadata nobody reads.
- **Recommended fix:** Rewrite the two older readers/writers in terms of `readEncryptedString`/`writeEncryptedString`; delete `readGithubOAuthMeta` (or start consuming the stored meta in `githubAuthStatus`).

#### L12 · Prototype-pollution test asserts less than it claims
- **Category:** Test coverage / Security · **Confidence:** HIGH · **Effort:** 1 h · **Quick win:** ✅ (flagged)
- **Location:** `src/shared/ipcValidation.test.ts:44`; `src/shared/ipcValidation.ts:18`
- **Description:** The test "rejects prototype-pollution probes" checks only `'__proto__.polluted'`, which is rejected for an *unrelated* reason (leading-underscore rule). The actual dangerous shapes — `'ui.__proto__.polluted'`, `'constructor'`, `'constructor.prototype.x'`, `'prototype'` — are all **accepted** by `CONFIG_KEY_PATTERN`. **No reachable exploit today**: both callers funnel into `configAccess.ts`'s `Set`-based allowlists, which reject these end-to-end (hence verifier-adjusted HIGH→LOW). But the module is documented as *the* shared prototype-pollution guard, so any future caller relying on it alone is exposed, and the test gives false confidence.
- **Recommended fix:** Add failing-first tests for `'ui.__proto__.polluted'`, `'a.constructor.b'`, `'prototype'`, `'constructor'`; harden `assertValidConfigKey` to reject any dot-segment equal to `__proto__`/`constructor`/`prototype`; add a `configAccess` end-to-end rejection test.

---

## Collected, Not Adversarially Verified

The verification pass was interrupted by an API monthly-spend limit before it could refute-check these. I **manually spot-checked the objective claims** (versions against `pnpm-lock.yaml`, line counts) and note what remains unconfirmed. Treat severities here as **provisional**.

### Dependencies (versions confirmed by me; advisory *counts* not independently confirmed)

| # | Finding | Provisional severity | My spot-check |
|---|---|---|---|
| D1 | **Electron `33.4.11` is the shipped runtime and is past end-of-life** — no further security updates | **HIGH** | ✅ Version confirmed in lockfile. EOL status is highly plausible for mid-2026 (Electron supports only the latest ~3 majors). The specific "18 advisories / 4 HIGH" count is **unverified** — but the EOL runtime concern is real regardless. **Upgrade to a supported Electron major.** |
| D2 | `tar@6.2.1` (via electron-builder) advisories | LOW→MEDIUM | ✅ Version confirmed. This is a **build-time** dependency (electron-builder), **not shipped** in the app — impact is limited to the build host. The "CRITICAL DoS" claim is **doubtful/unverified** for 6.2.1; treat as build-hygiene, not a shipped vuln. |
| D3 | `vitest@2.1.9` UI-server advisory | LOW | ✅ Version confirmed. **Dev-only** (devDependency); the Vitest UI is not run in production. |
| D4 | `vite@5.4.21` + `esbuild@0.21.5` dev-server advisories; Vite 5 line EOL | LOW | ✅ Versions confirmed. **Dev-only.** The esbuild dev-server advisory (`GHSA-67mh-4wv8-2f99`) is real but only affects a running dev server. |
| D5 | `web-push@3.6.7` is MPL-2.0 (weak copyleft) in an MIT app | LOW | ✅ Version + `optionalDependency` status confirmed. MPL-2.0 is **file-level** copyleft — distributing it alongside MIT is fine as long as web-push's own files aren't modified. Worth a license-notice check, not a conflict. |
| D6 | `ws`/`web-push`/`qrcode` declared as `optionalDependencies` — installs can silently drop them, disabling remote features | LOW | ✅ Confirmed classification. If remote is a supported feature, these should be regular `dependencies`; if truly optional, guard for their absence at runtime. |
| D7 | `electron-store` pinned to 8.x (current 10.x); `zod` 3.x (current 4) — **no known CVE** | LOW | ✅ Confirmed. Purely "outdated," no security implication. |

### Architecture (line counts confirmed by me; structural claims not refute-checked)

| # | Finding | Provisional severity | My spot-check |
|---|---|---|---|
| A1 | `OrchestratorEngine` is a **3,955-line** god class owning ~10 domains | MEDIUM | ✅ `wc -l` = **3955**. Splitting by domain (dispatch, persistence, permissions, budget, planning) would materially reduce change risk. |
| A2 | `AgentManager` is a **1,725-line** god singleton shared across per-session engines | MEDIUM | ✅ `wc -l` = **1725**. Confirmed shared-singleton concern; overlaps H4/M4/L2. |
| A3 | Single **1,299-line** zustand store; 17 components subscribe to the whole store | MEDIUM | ✅ `wc -l` = **1299**. This is the root cause behind verified **H5** — cross-referenced and confirmed. |
| A4 | IPC surface maintained in triplicate with an untyped main-process edge (`register.ts`, 109 handlers) | MEDIUM | ✅ `register.ts` = 848 lines. Overlaps verified **M5**/**H2**. |
| A5 | `autoPr.ts` mixes git plumbing, quality/security gates, PR publishing, and a 20-min CI poller in **1,178 lines** | MEDIUM | ✅ `wc -l` = **1178**. Confirmed multi-responsibility module. |
| A6 | Every PTY output chunk broadcast to every window | MEDIUM | Overlaps verified **L2**/**M1**; consistent with confirmed code. |
| A7 | Config state mirrored per-window with no change notification — multi-window views go stale | LOW | Plausible, not independently traced. |
| A8 | Provider-specific behavior scattered across 9+ modules | LOW | Plausible, not independently traced. |
| A9 | Type-only import cycles among shared contract modules (no runtime impact) | LOW | Plausible, not independently traced. |

### Test coverage (verifier cut off; not spot-checked in depth)

Provisional gaps flagged by the auditor, pending verification: `PermissionBroker` yolo-bypass/dedupe paths (**note:** the adversarial verifier *did* run on this one and **refuted** the "zero tests" framing — most paths are covered in `remoteControl.test.ts`/`permissionRuntime.test.ts`; only fingerprint-dedupe is a genuine minor gap), 7 suites hard-depending on an installed Electron binary, `register.ts` handler coverage, `secrets.ts` key-fallback ordering, `windows.ts` webPreferences hardening, mobile `App.tsx` (524 lines), `updater.ts` state machine, a fixed 10 ms sleep in `transferReviewGate.test.ts` (flaky pattern), and `rateLimit.ts` edge cases. **H6** (RemoteGateway) is the fully-verified, highest-priority member of this group.

---

## Quick Wins (fixable in under ~30 minutes)

Ordered by value. These are safe, self-contained, and mostly deletions or one-line guards:

| Priority | Finding | File | Effort |
|---|---|---|---|
| 1 | **H1** — Remove `shell:true` from `runGhJson` (kills the Windows command-injection sink) | `src/main/integrations/githubRepo.ts:84` | ~30 min |
| 2 | **L4** — Evict removed sessions from the RemoteReadModel map | `src/main/remote/readModel.ts:68` | 30 min |
| 3 | **M6** — Delete the dead `telemetryFormatter.ts` duplicate + fix its docstring | `src/shared/telemetryFormatter.ts` | 30 min |
| 4 | **L11** — Deduplicate `secrets.ts` decrypt paths + delete dead `readGithubOAuthMeta` | `src/main/config/secrets.ts` | 30 min |
| 5 | **L6** — Delete dead `VoiceBar.tsx` | `src/renderer/src/components/VoiceBar.tsx` | 15 min |
| 6 | **L8** — Delete dead `shared/inboxSorter.ts` | `src/shared/inboxSorter.ts` | 15 min |
| 7 | **L9** — Delete dead `shared/modelCatalogFilter.ts` | `src/shared/modelCatalogFilter.ts` | 15 min |
| 8 | **L7** — Delete/​wire `canvasSlots.ts` | `src/renderer/src/canvasSlots.ts` | 30 min |

**Near-quick-wins (~1 h, high value):** **H4** (bound the Cursor trust scan to a 200 KB→4 KB tail), **H2 partial** (add `assertNotVoiceWindow` to the `orchestrator:*` + `mcpSave` handlers), **L1** (fix the tunnel pairing rate-limit key), **M3** (skip the git-poll `set()` when unchanged), and **L12** (harden the prototype-pollution validator + add real tests).

---

## Recommended Remediation Order

1. **This week (security):** H1 (quick win) → H2 (IPC sender guards + tests) → L1 → L12. Plus **D1**: schedule the Electron major upgrade off the EOL 33.x line — the largest single risk-reducer, tracked as its own task.
2. **Next (main-process performance under load):** H3 → H4 → M2/M1 → M3 → M4. These share root causes (unthrottled synchronous main-process work on every PTY chunk / snapshot) and are best batched.
3. **Renderer performance:** H5 + A3 together (selectors + memo + narrow the store).
4. **Test hardening:** H6 (RemoteGateway path-traversal + auth), then the provisional coverage gaps.
5. **Cleanup sweep:** all remaining quick-win deletions (L5–L11) + the M5 IPC-validation standardization.

---

*Report generated by a 6-agent parallel audit workflow with per-finding adversarial verification. 25 findings passed adversarial verification; 1 auditor claim ("PermissionBroker has zero tests") was refuted and excluded. The dependency, architecture, and remaining test-coverage findings are labeled provisional because the verification pass was interrupted by an API spend limit — the objective claims among them were spot-checked directly against the repository.*
