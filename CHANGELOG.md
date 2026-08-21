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
