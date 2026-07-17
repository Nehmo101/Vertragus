# Contributing to Vertragus

Thanks for helping build Vertragus. This document describes the **branching
model** every change must follow.

## Branching model

Vertragus uses a single-trunk flow:

```
short-lived branch  ──PR──▶  main
```

| Branch | Purpose |
|---|---|
| `main` | **The trunk.** Always releasable; every push runs the full CI. Changes arrive only through green pull requests. |
| `retros` | **Data branch** used by the retro-sync feature (exported run retros/learnings). Never commit application code here. |
| `feature/*`, `fix/*`, `claude/*` | **Short-lived working branches.** One per change, branched off `main`, merged back via pull request, deleted after merge. |
| `orca/*` | **Runtime branches** created automatically by agent worktrees. Not for humans; cleaned up by the app. |

### The rule

> **Every change reaches `main` only through a pull request with green CI.**
> No direct commits to `main`.

## Workflow

### 1. Start from `main`

```bash
git checkout main
git pull origin main
git checkout -b feature/my-change   # or fix/…, or an agent's claude/… branch
```

### 2. Do the work and keep it green

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run ci            # lint + typecheck + tests + production build
corepack pnpm run test:ui-smoke # optional: critical Electron UI surfaces
```

### 3. Open a pull request into `main`

```bash
git push -u origin feature/my-change
```

The PR is reviewed and CI must pass before it is merged. Delete the branch
after the merge. Tag releases on `main` if desired (`git tag vX.Y.Z`).

## Enforcing the rule on GitHub (recommended)

Use a **branch protection rule / ruleset** for `main` under
**Settings → Branches**:

- ✅ **Require a pull request before merging**
- ✅ **Require status checks to pass before merging** (select the CI workflow)
- ✅ **Do not allow bypassing the above settings** / block direct pushes

With this in place, the only way into `main` is a reviewed, green PR — the
rule is enforced by the platform, not just by convention.

## Commit messages

Use short, descriptive, imperative subject lines, matching the existing history
(e.g. `Orchestration: parallel dispatch + capacity-aware queueing`).
