# Security Policy

Vertragus orchestrates real coding agents with real filesystem and git
access — security reports are taken seriously.

## Reporting a vulnerability

Please use **GitHub's private vulnerability reporting** for this repository
(Security → Report a vulnerability). Do not open public issues for
exploitable problems.

You can expect an initial response within a few days. Please include steps
to reproduce and, where relevant, the provider CLIs and platform involved.

## Scope notes

- Vertragus never stores provider credentials; logins happen in each CLI's
  own visible terminal.
- Agent worktrees are isolated per task; Auto-PR never force-pushes and
  never pushes to the default branch.
- Yolo mode (auto-approve) is opt-in per agent, marked in the UI and
  covered by a global kill-switch — reports about bypasses of these
  guarantees are especially welcome.
