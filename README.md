# 🐋 Orca-Strator

Orchestrate and run multiple AI coding agents **in parallel** from one
cross-platform desktop app (**Windows + Linux**).

Orca-Strator drives the agent CLIs you already have installed — each in its own
live terminal — and lets one configurable **orchestrator** delegate work to
**subagents** across tools.

## Supported agents & integrations

| Provider | Command | Role |
|---|---|---|
| **Claude Code** | `claude` | agent / orchestrator (e.g. model *Fable*) |
| **Codex** | `codex` | agent (e.g. GPT‑5.6) |
| **Cursor Agent** | `cursor-agent` | agent (e.g. GPT‑5.6 / Sonnet) |
| **Ollama** | `ollama` | local LLMs (HTTP API on `:11434`) |
| **GitHub** | `gh` | repo / branch / PR context |
| **Cloudflare Tunnel** | `cloudflared` | remote access (later) |

> The CLIs authenticate through their own subscriptions. Orca-Strator invokes
> the already‑authenticated tools and does **not** manage their API keys.

## Key features

- **Multi-agent workspace** — a tiled grid of live terminals; pop any pane out
  into its own OS window (hybrid grid + pop-out).
- **Configurable orchestration** — pick who orchestrates whom, e.g. a
  Claude/*Fable* orchestrator driving **3× GPT‑5.6** subagents.
- **Yolo Mode** — per-agent and global auto-approve so agents work without
  prompts (`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`
  / `--yolo`), with a red warning badge, a global kill-switch, and git-worktree
  isolation.
- **Worktree isolation, approvals inbox, cost/token tracking** and a provider
  health dashboard.

## Tech stack

Electron · TypeScript · React · Vite (`electron-vite`) · node-pty + xterm.js
(terminals, Phase 1) · electron-store + zod (config) · electron-builder
(packaging: NSIS `.exe` + AppImage/`.deb`).

## Development

```bash
pnpm install     # flat node_modules via .npmrc (node-linker=hoisted)
pnpm dev         # launch the app with HMR
pnpm typecheck   # type-check main + preload + renderer
pnpm build       # typecheck + production build
```

### Packaging

```bash
pnpm build:win     # Windows NSIS installer
pnpm build:linux   # Linux AppImage + .deb
```

## Roadmap

- **Phase 0** — repo & scaffold, config store, provider health ✔
- **Phase 0.5** — UI layout/mockup (design handoff) ✔
- **Phase 1** — multi-agent grid with live PTY terminals, pop-out windows,
  Yolo mode + kill switch, worktree isolation, profile editor *(current —
  approvals inbox & cost/token tracking still open)*
- **Phase 2** — orchestrator engine + MCP dispatch, task DAG, diff/merge view
- **Phase 3** — Cloudflare Tunnel, session persistence, installers

## License

[MIT](./LICENSE) © 2026 Nehmo101
