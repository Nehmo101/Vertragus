Deutsch | [English](CONTRIBUTING.md)

# Zu Vertragus beitragen

## Bauen und testen

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev          # Start mit HMR
corepack pnpm run test     # vitest, einmalig
corepack pnpm run ci       # Lint + Typecheck (node & web) + Tests + beide Builds
```

`pnpm run ci` ist das kanonische Gate — dasselbe Kommando, das CI auf
Windows (der primären, owner-verifizierten Plattform), Linux und macOS
fährt. CI führt zusätzlich die Coverage-Ratchet aus
(`pnpm run test:coverage`; die Schwellen in `vitest.config.ts` liegen knapp
unter dem gemessenen Status quo, Coverage kann sich also nur nach oben
bewegen) und einen Panel-Smoke-Test, der die echte Electron-App bootet
(`scripts/panel-smoke.mjs`). Ein Packaging-Job beweist, dass die Installer
weiterhin bauen; aus CI wird nichts veröffentlicht.

Nützliche Einzelteile: `pnpm run typecheck:node` / `typecheck:web` für ein
Projekt, `pnpm run test:watch` während der Entwicklung, `pnpm run icons`
zum Neuerzeugen der Icons aus `build/icon.svg`, und
`VERTRAGUS_DEV_RUN=<repo> pnpm dev` für einen headless Dev-Workspace auf
einem echten Repository.

## Erwartungen an Pull Requests

- `pnpm run ci` lokal grün, bevor du pushst. Keine übersprungenen Tests,
  keine gesenkten Coverage-Schwellen.
- Neues Verhalten kommt mit Tests — diese Codebasis pinnt Invarianten
  (Event-Ownership, Tool-Allow-Lists, i18n-Parität, Doc-Twin-Integrität)
  mit dateilesenden Guard-Tests inklusive Selbst-Checks, damit eine still
  kaputte Regex nicht durchrutschen kann. Folge diesem Muster.
- Diffs minimal und bei einem Thema halten; das Repo arbeitet in Tracks,
  nicht in Omnibus-PRs.

## Sprachpolicy

- **Code, Kommentare, Commit-Messages und alles Modell-Gerichtete**
  (Tool-Descriptions, Contracts, Orchestrator-/Rollen-Prompts) sind
  **Englisch**.
- **Doku ist englisch-kanonisch mit gepflegten deutschen Zwillingen**: Die
  kanonische Datei ist englisch benannt und englischsprachig, ihr deutscher
  Zwilling liegt daneben als `<NAME>.de.md`. Beide beginnen mit einer
  Sprachumschalt-Zeile. Wer eine kanonische Doku anfasst, aktualisiert den
  Zwilling im selben PR — `scripts/docsTwins.test.ts` erzwingt identische
  Heading-Bäume und Link-Ziele und schlägt bei deutschem Text fehl, der in
  einem englischen Kanon zurückbleibt.
- **UI-Strings** leben nie inline; sie laufen über die drei i18n-Schichten:
  die i18next-Bundles des Renderers
  (`src/renderer/src/i18n/locales/de.json` / `en.json`, von `i18n.test.ts`
  auf Key-Parität, tote Keys und unübersetzte Texte bewacht), die
  Main-Process-Nachrichtentabelle (`src/shared/mainMessages.ts`) für native
  Dialoge und Fehler, die durch IPC reisen, wo kein `t()` läuft, und das
  Bundle des Remote-Web-Clients (`src/remoteClient/i18n.ts`), das dem
  `hello.locale` des Gateways folgt. Trage jeden neuen String in beide
  Sprachen der richtigen Schicht ein.

## Sicherheit

Melde Schwachstellen nicht in öffentlichen Issues — siehe
[`SECURITY.md`](SECURITY.md).
