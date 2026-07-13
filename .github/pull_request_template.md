<!--
  Branching rule: changes go to `DEV` first, then reach `main` via a merge
  from `DEV`. Feature/fix/agent PRs must target `DEV` as their base branch.
  See CONTRIBUTING.md.
-->

## Summary

<!-- What does this change do and why? -->

## Base branch

- [ ] This PR targets **`DEV`** (feature / fix / agent work — the default).
- [ ] This PR is a **`DEV` → `main` promotion** (release only).

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` passes
