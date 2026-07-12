# Contributing to Orca-Strator

Thanks for helping build Orca-Strator. This document describes the **branching
model** every change must follow.

## Branching model

Orca-Strator uses a two-tier integration flow:

```
feature branch  ──PR──▶  dev  ──merge──▶  main
```

| Branch        | Purpose                                                                 |
|---------------|-------------------------------------------------------------------------|
| `main`        | **Stable / release branch.** Always deployable. Only receives changes by merging `dev`. Never commit or push here directly. |
| `dev`         | **Integration branch.** All work lands here first and is validated together before it flows to `main`. |
| `feature/*`, `fix/*`, `claude/*` | **Short-lived working branches.** One per change (a feature, a fix, or an agent run). Branched off `dev`, merged back into `dev` via pull request. |

### The rule

> **Every change goes to `dev` first, and reaches `main` only through a merge
> from `dev`.** No direct commits to `main`.

This keeps `main` releasable at all times while `dev` absorbs work-in-progress
and integration risk.

## Workflow

### 1. Start from `dev`

```bash
git checkout dev
git pull origin dev
git checkout -b feature/my-change   # or fix/…, or an agent's claude/… branch
```

### 2. Do the work and keep it green

```bash
pnpm install
pnpm typecheck   # type-check main + preload + renderer
pnpm build       # typecheck + production build
```

### 3. Open a pull request **into `dev`**

Push your branch and open a PR with **base = `dev`** (never `main`):

```bash
git push -u origin feature/my-change
```

The PR is reviewed and CI must pass before it is merged into `dev`.

### 4. Promote `dev` → `main`

When `dev` is stable and ready to release, promote it to `main` with a merge:

```bash
git checkout main
git pull origin main
git merge --no-ff dev          # bring the integrated dev history into main
git push origin main
```

Using `--no-ff` keeps an explicit merge commit that marks each promotion of
`dev` into `main`. Tag releases on `main` if desired (`git tag vX.Y.Z`).

## Enforcing the rule on GitHub (recommended)

The convention above is enforced most reliably with a **branch protection rule**
on `main`. In the GitHub repository under
**Settings → Branches → Add branch ruleset** (or *Branch protection rules*) for
`main`:

- ✅ **Require a pull request before merging**
- ✅ **Require status checks to pass before merging** (select the CI workflow)
- ✅ **Do not allow bypassing the above settings** / block direct pushes

With this in place, the only way into `main` is a reviewed, green PR from
`dev` — the rule is enforced by the platform, not just by convention.

## Commit messages

Use short, descriptive, imperative subject lines, matching the existing history
(e.g. `Orchestration: parallel dispatch + capacity-aware queueing`).
