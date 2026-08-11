<p align="center">
  <img src="build/icon.svg" width="112" alt="Vertragus — a greyhound in full sprint with verdigris speed lines" />
</p>

<h1 align="center">Vertragus</h1>

<p align="center">
  <b>Orchestrate AI coding agents in parallel</b><br />
  A translucent panel that runs your agent CLIs as a coordinated team
</p>

Vertragus is a small always-on-top glass panel. You define **profiles** — a
repo path, an orchestrator CLI (Claude, Codex, Kimi, Cursor, …) and a set of
subagent roles — and press play. The orchestrator opens in its own translucent
terminal window, and starts **visible** subagent windows on demand. Agents and
orchestrator talk over a slim in-app MCP server with true blocking
communication: no polling, no starving workers.

The name is *vertragus*, the ancient Gaulish-Latin word for a greyhound.
Agents are named after the Divine Comedy — orchestrators get guides
(Virgilio, Beatrice, …), subagents get the cast (Caronte, Ulisse, …),
workspaces get places (Paradiso, Inferno, …).

> **Status: early rework.** This repository is a ground-up restart of
> [Vertragus-Archiv](https://github.com/Nehmo101/Vertragus-Archiv) with a
> radically smaller core. Nothing here is release-ready yet.

## Development

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev        # launch with HMR
corepack pnpm run ci     # lint + typecheck + test + build — the canonical gate
```

Windows is the primary, owner-verified platform; macOS and Linux are built in
CI on a best-effort basis.

## License

[MIT](./LICENSE) © 2026 Nehmo101
