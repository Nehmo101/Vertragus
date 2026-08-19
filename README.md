<p align="center">
  <img src="build/icon.svg" width="112" alt="Vertragus — a greyhound in full sprint with verdigris speed lines" />
</p>

<h1 align="center">Vertragus</h1>

<p align="center">
  <b>Orchestrate AI coding agents in parallel</b><br />
  A translucent panel that runs your agent CLIs as a coordinated team
</p>

Vertragus is a small always-on-top glass panel. You define **profiles** — a
repo path, an orchestrator CLI (Claude, Codex, Kimi, Cursor, Grok Build, …) and a set of
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

The German handbook [`docs/HANDBUCH-HARNESS.md`](docs/HANDBUCH-HARNESS.md)
is a code-grounded look at the harness core after the robustness and
Tailscale-remote work: host-truth for verification (`inspect_agent`) and
handoff, the human inside the event loop — without a second *concurrent*
orchestrator. Planned serial root succession (fresh context, same team) is
sketched in [`docs/ORCHESTRATOR-SUCCESSION.md`](docs/ORCHESTRATOR-SUCCESSION.md).

## Remote access (Tailscale)

Vertragus can be driven from your phone or another browser while it runs on
your PC. It is **off by default**; enable it under **Settings → Remote access**.

- **Transport is your tailnet.** The remote server binds, by default, to the
  machine's auto-detected [Tailscale](https://tailscale.com) address
  (`100.64.0.0/10`). Traffic is WireGuard-encrypted by Tailscale end to end, so
  Vertragus adds no TLS and opens no port to the public internet. `0.0.0.0`
  (all interfaces, including your LAN) is available behind an explicit typed
  confirmation — use it only when you understand the exposure.
- **Pairing.** Enabling generates a 256-bit pairing token, shown as a QR code
  and a link. Scanning it on a device on the same tailnet exchanges the token
  for a session; the token is stored encrypted at rest (Electron `safeStorage`)
  and never leaves the machine in plaintext. Regenerating it disconnects every
  paired device.
- **What a remote device can do.** Watch any agent's terminal live, type into
  it, and start or stop workspaces. The command allow-list is exactly four
  verbs: `workspaces:list`, `workspaces:start`, `workspaces:stop`,
  `profiles:list`. There is no `focus_agent` or `stop_agent` on the gateway.
  Typing into a PTY reaches the CLI (permission dialogs live there); it does
  **not** resolve an MCP `ask_orchestrator` wait — that still needs
  `send_to_agent{questionId}` on the orchestrator, which remote v1 does not
  expose. It **cannot** edit profiles, providers or settings, touch windows
  or zones, or remove worktrees.
- **Threat model — read this.** Subagents run in YOLO mode
  (`--dangerously-skip-permissions`). **A paired device therefore has code
  execution on your PC through the agents it drives.** Only pair devices you
  would trust with the machine itself. The settings section lists connected
  devices and lets you disconnect any of them; disabling remote access or
  regenerating the token severs every session immediately. The in-app MCP
  server that agents use stays loopback-only and is a separate listener with a
  separate token domain — remote access never widens it.

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
