English | [Deutsch](SECURITY.de.md)

# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them
privately via
[GitHub's private vulnerability reporting](https://github.com/Nehmo101/Vertragus/security/advisories/new)
on this repository. Describe what you found, how to reproduce it, and what
an attacker could gain. You will get a response in the advisory thread;
fixes ship through the normal release channel.

Vertragus is in an early rework and not release-ready; there are no
supported-version guarantees yet — reports are assessed against `main`.

## Threat model

Vertragus runs AI coding agents as real CLI processes on your machine, in
git worktrees of your repository. Be honest with yourself about what that
means: an agent is code execution with your user account's rights.

### Subagent policy tiers

The **subagent policy** (settings window) has three tiers — be honest with
yourself about what each one actually guarantees:

| Tier | CLI permission flags | Enforcement | Trade-off |
| --- | --- | --- | --- |
| `yolo` (default) | skip-permissions on | none | Full autonomy. An agent can run any command your user account can. |
| `ask-user` | off | **hard** — the CLI's own permission prompt blocks in the agent's terminal | Safest, but needs you at the desktop; unattended runs stall. Remote v1 deliberately does not relay these CLI prompts to a phone. |
| `ask-orchestrator` | skip-permissions on | **soft** — the task contract requires `ask_orchestrator` approval before risky actions | Keeps runs unattended, and the orchestrator can escalate to you via `ask_user`. But it is prompt-level only: a misbehaving or manipulated agent can ignore the rule. Treat it as guidance for honest agents, not as a sandbox. |

Orchestrators and leads never get yolo flags under any tier — they operate
through an MCP tool allow-list instead. The panel footer's yolo switch is
the coarse control: on = `yolo`, off = `ask-user`; the three-way picker
lives in the settings window, and both write the same stored truth.

There is no sandbox. `ask-orchestrator` is a contract rule, not
confinement; agents also need network access (MCP, vendor APIs) by design.
If you cannot afford an agent running arbitrary commands as your user, use
`ask-user` and stay at the desktop.

### Remote access

Remote access is **off by default**. When enabled, the remote server binds
to the machine's Tailscale address (`100.64.0.0/10`) by default; transport
security is your tailnet's WireGuard encryption — Vertragus adds no TLS and
opens no port to the public internet. Binding to `0.0.0.0` (all
interfaces) sits behind an explicit typed confirmation.

Pairing uses a 256-bit token (QR/link), stored encrypted at rest (Electron
`safeStorage`) plus a 0600 fallback file under userData. **A paired device
has code execution on your PC through the agents it drives** — under the
default `yolo` tier, starting a workspace with a goal is running code. Only
pair devices you would trust with the machine itself. The settings section
lists connected devices and lets you disconnect any of them; disabling
remote access or regenerating the token severs every session immediately.

The gateway command allow-list is exactly six verbs (`workspaces:list`,
`workspaces:start`, `workspaces:stop`, `profiles:list`, `answer_question`,
`user_message`). A remote device cannot edit profiles, providers or
settings, touch windows or zones, remove worktrees, or promote branches.

### In-app MCP server

The MCP server agents talk to is loopback-only, with per-identity tokens
(orchestrator / lead / subagent, per-agent HMAC subtokens) and host/origin
checking. It is a separate listener with a separate token domain — remote
access never widens it. Token-carrying MCP config files are kept out of
your git history (`.git/info/exclude`; Codex uses process-local overrides).

### Chromium extension

The first-party extension drives **your** real Chromium on behalf of a
worker. Same loopback listener as MCP, different path (`/browser`) and a
separate pairing token. `chrome-extension:` origins are accepted only on
that path. A yolo-mode worker can click, type and screenshot any tab the
extension can see — pair only while you are watching the run, and rotate
the token from Settings when you are done. This is not extra MCP and not a
second MCP server. How-to: [`docs/CHROMIUM-EXTENSION.md`](docs/CHROMIUM-EXTENSION.md).

### Git blast radius

Agents work in per-agent worktrees on `vertragus/*` branches; nothing is
auto-deleted, workers never commit (the host snapshots), there is no push,
and merging a result into your own branch is a human click in the panel
that refuses a dirty main checkout.
