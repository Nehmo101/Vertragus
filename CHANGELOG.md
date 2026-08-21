English | [Deutsch](CHANGELOG.de.md)

# Changelog

All notable changes to Vertragus are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
No release has been tagged yet; everything lives under Unreleased.

## [Unreleased]

### Added

- **Phase G (dsh adoption), all five patterns:**
  - Spill instead of truncation — oversized `read_output` and
    `inspect_agent` results are stored verbatim under
    `.vertragus/runs/<ws>/spill/` and returned as head/tail preview + path.
  - Quiet events — echoes of the orchestrator's own tool calls and
    `agent_progress` no longer wake `await_events`; they ride along on the
    next wake or timeout.
  - Structured reports — `start_agent{resultSchema}` validates the agent's
    final report as a JSON object; invalid results bounce back to the child
    with exact paths.
  - Shared task board — `task_create` / `task_update` / `task_list` with
    CAS revisions, `blockedBy` dependencies and ownership; survives
    succession and resume; `start_agent{taskId}` claims a task.
  - `search_runs` — root-only full-text search over this repository's past
    run journals.
- `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md` and this changelog, each
  with a German `.de.md` twin.
- `scripts/docsTwins.test.ts` — CI guard for the dual-language docs:
  matching heading trees and link targets per twin pair, no German copy in
  English canonicals, no orphan twins, no dead doc links or doc references
  in source comments.
- **English blurbs for every agent, workspace and place name**, so the
  English UI no longer shows German hover cards.
- **Code-signing and notarization plumbing**, dormant until repository
  secrets exist: Azure Trusted Signing for Windows, Developer ID plus
  notarization for macOS (which only joins releases once signing works,
  because Squirrel.Mac refuses unsigned auto-updates), per-OS post-package
  signature verification, and `docs/SIGNING.md`.
- **Provider verification matrix**: argv snapshots for every preset and
  launch shape, a `PRESET_VERIFICATION` map with a drift hint in the
  provider editor, a weekly best-effort spawn probe workflow, and
  `docs/RELEASE-CHECKLIST.md`.
- Integration scenarios for the Phase-G features: a `resultSchema` loop
  over a real MCP server, and a task board carried across a succession.
- Guards against language drift: a scanner that fails on German literals
  in the main process outside `mainMessages.ts`, and a parity check for the
  remote client's copy.

- **Succession survives a host crash.** The handoff package now lives beside
  the run's other artefacts instead of in the app's own data directory, and
  a resume that finds an unconsumed one seeds the successor from it — while
  saying plainly that the dead run's questions are void. A package the
  journal contradicts is refused, and a failed handoff retires its own
  package so it can never be replayed over newer work.
- **Replace the orchestrator from the panel.** A dead or silent orchestrator
  can be swapped for a fresh-context successor that keeps the team, the
  queue and the board; the predecessor's window stays open as the
  post-mortem.
- **The task board on the workspace card**, read-only and live, with the
  run's artefact folder one click away — and the same board on the phone,
  because the gateway already forwards the summary.
- **A guided first run**: which agent CLIs are installed, whether they are
  signed in, a button to the first profile, and a pointer at Play.

### Fixed

- The PTY-idle hint reached the orchestrator model in German on an
  otherwise English channel; it is English now.
- A subagent's result schema leaked in the registry when the agent exited
  on its own (only `stop_agent` and start failures released it).
- The profile editor interpolated a German failure fragment into an English
  sentence; provider auth hints and discovery details now follow the UI
  language.
- On a true first run the UI language follows the operating system instead
  of defaulting to German; a stored choice always wins.

### Changed

- **Documentation is now English-canonical with maintained German twins.**
  The German handbook `docs/HANDBUCH-HARNESS.md` was translated to
  `docs/HANDBOOK-HARNESS.md` (German original now
  `docs/HANDBOOK-HARNESS.de.md`; the old path is a stub);
  `docs/PROMPT-MCP-HARNESS.md` and `docs/REMOTE-CLIENT-MOBILE.md` are now
  English with German twins; `docs/ORCHESTRATOR-SUCCESSION.md` and
  `README.md` gained German twins. `docs/PLAN-DSH-ADOPTION.md` and
  `docs/RESEARCH-DEEPSEEK-HARNESS.md` stay German as historical records.
- The README's remote threat model moved to `SECURITY.md`; the README keeps
  a short summary and a link.
- The Docs role prompt now states the new language policy: docs are
  English-canonical with maintained German `.de.md` twins — write both when
  touching docs.
