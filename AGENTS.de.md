Deutsch | [English](AGENTS.md)

# Leitfaden für Coding-Agenten

Vertragus ist ein Electron-Panel, das AI-Coding-Agent-CLIs über einen
In-App-MCP-Server orchestriert. Lies `README.md` für das Produkt;
`docs/HANDBOOK-HARNESS.md` ist die code-verankerte Karte des Harness-Kerns.

## Aufbau

- `src/main/` — Electron-Main-Process: `workspace/` (Workspace,
  WorkspaceManager — PTYs, Worktrees, Events), `mcp/` (Server, Tools,
  Event-Queue, Fragen, Attach-Dialekte), `providers/`, `remote/`
  (Tailscale-Gateway), `windows/`, `store/`, `appIpc.ts`.
- `src/shared/` — Schemas (zod, `schema/`), Prompts (`prompts/`),
  `mainMessages.ts` (Main-Process-i18n), Lore/Namen.
- `src/renderer/` — React-Panel + Fenster; i18next unter
  `src/renderer/src/i18n/`.
- `src/remoteClient/` — der Handy-Web-Client (eigenes kleines i18n-Bundle).
- `tests/integration/`, `tests/live/` — voller MCP-Loop über echtes HTTP,
  Orchestrierung über echtes Git; Live-Tests hinter `VERTRAGUS_LIVE=1`.
- `scripts/` — Icons, Panel-Smoke und Guard-Tests; `docs/` — Handbuch und
  Pläne, englisch-kanonisch mit deutschen `.de.md`-Zwillingen.

## Verifizieren

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run ci   # Lint + Typecheck node/web + alle Tests + beide Builds
```

`pnpm run ci` grün ist die Definition von fertig. Coverage ist eine Ratchet
(`vitest.config.ts`) — Schwellen nie senken. Tests liegen neben ihrem
Gegenstand (`foo.test.ts` neben `foo.ts`).

## Konventionen

- Alles im Code ist Englisch: Kommentare, Tool-Descriptions, Contracts,
  Prompts. UI-Strings laufen über die i18n-Schichten (Renderer-i18next
  de+en, `src/shared/mainMessages.ts`, `src/remoteClient/i18n.ts`) — immer
  beide Sprachen.
- Doku ist englisch-kanonisch; jede kanonische Doku hat einen deutschen
  `.de.md`-Zwilling mit derselben Heading-Struktur und denselben
  Link-Zielen. Doku angefasst → Zwilling in derselben Änderung
  aktualisieren. `scripts/docsTwins.test.ts` erzwingt das.
- Invarianten-Test-Kultur: Querschnittsregeln werden mit dateilesenden
  Guard-Tests samt Selbst-Checks gepinnt (z. B. `i18n.test.ts`,
  Security-Contracts, docsTwins). Wer eine Invariante hinzufügt, baut einen
  Guard dazu, der laut fehlschlägt, wenn sein eigenes Scannen kaputtgeht.
- Respektiere die Doktrin der Handbuch-Non-Goals: ein Host-Pfad pro
  Anliegen, kein Peer-to-Peer zwischen Agenten, kein Autodelete, kein RAG,
  Host-Wahrheit vor Agenten-Prosa, Allow-Lists bleiben minimal.
- Diffs klein und bei einem Thema halten; referenziere den Handbuch-Track,
  den du umsetzt.
