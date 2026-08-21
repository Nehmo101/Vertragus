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

## Versionierung und Releases

Vertragus liefert zwei Update-Kanäle aus einem Repository: Jeder grüne Build
von `main` wird ein Prerelease auf dem `main`-Kanal, ein gepushter Tag
`vX.Y.0` ein normales Release auf `latest`. Eine Installation folgt genau
einem davon (`applyChannel` in `src/main/updater.ts`), die beiden sehen die
Builds des jeweils anderen also nie.

Die `version` in `package.json` ist eine **Patch-Basis**, kein Zähler: Der
Release-Workflow ADDIERT die Run-Nummer auf den Patch, ein eingecheckter
`1.1.0` erzeugt also Main-Builds `1.1.<run>-main.<attempt>.g<sha>`. Daraus
folgen zwei Regeln; die erste erzwingt `scripts/release-version.mjs` bei jedem
gepushten Tag:

- Eingecheckte Versionen sind immer `X.Y.0`; Releases werden als `vX.Y.0`
  getaggt, und der Tag muss der `package.json`-Version entsprechen — die
  Artefakte und `latest.yml` werden aus `package.json` benannt, nicht aus dem
  Tag.
- Direkt nach einem Release wird main auf `X.(Y+1).0` gehoben. Dessen
  Prereleases sortieren dann über dem gerade veröffentlichten Stable — so
  gewollt und harmlos, denn getrennt werden die Zielgruppen durch den KANAL,
  nicht durch die Versionsreihenfolge. Die Kanäle nicht zusammenlegen, um die
  Überlappung zu "reparieren".

Der vollständige Ablauf, Schritt für Schritt und als human bzw. automated
markiert, steht in
[`docs/RELEASE-CHECKLIST.md`](docs/RELEASE-CHECKLIST.md).

## Sicherheit

Melde Schwachstellen nicht in öffentlichen Issues — siehe
[`SECURITY.md`](SECURITY.md).
