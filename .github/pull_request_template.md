<!--
  Branching rule: changes go to `dev` first, then reach `main` via a merge
  from `dev`. Feature/fix/agent PRs must target `dev` as their base branch.
  See CONTRIBUTING.md.
-->

## Summary

<!-- What does this change do and why? -->

## Base branch

- [ ] This PR targets **`dev`** (feature / fix / agent work — the default).
- [ ] This PR is a **`dev` → `main` promotion** (release only).

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` passes
