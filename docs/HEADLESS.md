# Headless-Betrieb (`vertragus-headless`)

Stand: 28. Juli 2026 · Roadmap: [Open-Core-Roadmap, Zug 2](./ROADMAP_OPEN_CORE.md)

Vertragus kann ohne Fenster laufen: Mit `VERTRAGUS_HEADLESS=1` startet der volle
Host (Engine, MCP-Server, Agents, Session-Restore und das Mission-Control-Gateway),
aber ohne Fenster, Tray, Global-Shortcut und Updater. Gedacht für den Dauerbetrieb
auf einem Arbeitsrechner oder VPS, gesteuert von gepairten Mobilgeräten.

## Schnellstart

```bash
# Host starten (baut out/ bei Bedarf einmalig)
pnpm run headless

# In einem zweiten Terminal:
pnpm run headless -- status    # Gateway/Tunnel/Geräte abfragen
pnpm run headless -- pair      # Pairing starten: QR-Code im Terminal + Zahlencode
```

Optionen:

- `--user-data <dir>` — userData-Verzeichnis explizit angeben (für `status`/`pair`,
  falls der Host mit abweichendem Profil läuft).
- `--timeout <sek>` — Host nach N Sekunden geordnet beenden (Smoke-Tests, CI).
- `Ctrl+C` beendet den Host geordnet (Session-Flush → Agents → Gateway/Tunnel);
  reagiert er nicht binnen 10 s, wird der Prozessbaum hart beendet (Windows: `taskkill /T`).

**Voraussetzung:** Mission Control muss einmalig in der Desktop-App aktiviert worden
sein (Remote-Ansicht: Tunnel-Konfiguration bzw. Quick-Tunnel). Ohne aktiviertes
Remote läuft der Host zwar, warnt aber laut, dass er nicht fernsteuerbar ist —
`pair` schlägt dann mit klarer Meldung fehl.

## Wie die CLI mit dem Host spricht

Beim Headless-Start schreibt der Host eine Kontrolldatei
`<userData>/headless-control.json` (Port + Bearer-Token eines lokalen
Admin-Endpunkts, nur an `127.0.0.1` gebunden) und loggt strukturiert:

```
[headless] gateway=127.0.0.1:52341 tunnel=online url=https://… devices=1
[headless] control=127.0.0.1:52342 file=C:\Users\…\vertragus\headless-control.json
```

Die Kontrolldatei liegt neben dem verschlüsselten Device-Store im userData-Verzeichnis
(gleiche Vertrauensgrenze: wer sie lesen kann, ist der lokale Benutzer). Der
Kontroll-Endpunkt kann genau drei Dinge, die die Desktop-App dem lokalen Owner
ebenfalls anbietet: `GET /status`, `POST /pair` (startet eine Pairing-Challenge),
`POST /shutdown` (geordneter App-Quit). Beim Beenden wird die Datei entfernt.

## Was geht — und was (noch) nicht

**Geht:**

- Vollwertiger Host: Agents, Orchestrator, MCP-Server, Session-Restore.
- Mission Control als Client: die Mobile-PWA (über die Tunnel-URL) und die
  iOS-App steuern den Host wie gewohnt (Lesen, Steuern, Approvals, Push).
- Pairing komplett im Terminal: `pnpm run headless -- pair` rendert den QR-Code
  ASCII-basiert (optionales `qrcode`-Paket; fehlt es, werden Code + URL zur
  manuellen Eingabe ausgegeben).

**Geht bewusst noch nicht:**

- **Desktop-UI „Connect to host“:** Eine zweite Desktop-Instanz kann sich nicht
  als Client mit einem Headless-Host verbinden. Das ist das Folgeprojekt aus
  [Zug 2 der Open-Core-Roadmap](./ROADMAP_OPEN_CORE.md) (Host-/Client-Trennung
  der Desktop-App).
- **Remote aktivieren/konfigurieren headless:** Tunnel-Token, Access-Konfiguration
  und das Einschalten von Mission Control bleiben Desktop-Aufgaben (safeStorage +
  Owner-Interaktion). Die CLI weicht diese Absicherung bewusst nicht auf.
- Erststart auf einer Maschine ohne vorherige Desktop-Konfiguration ist damit
  nicht headless möglich.

## Sicherheitsmodell

- **Gateway:** bindet ausschließlich an `127.0.0.1`; der einzige Internet-Ingress
  ist der Cloudflare-Tunnel (Named Tunnel mit stabilem Hostname oder Quick-Tunnel).
  Host- und Origin-Header werden geprüft, Pairing ist ratenlimitiert, jede
  Autorisierung läuft über gehashte Geräte-Tokens; Audit-Log unter
  `<userData>/diagnostics/remote-audit.jsonl`.
- **Pairing:** Einmal-Code (5 min TTL, Single-Use); der QR enthält die Pairing-URL
  mit Code. Wer den Code sieht, kann sich pairen — Terminal entsprechend behandeln.
- **Kontroll-Endpunkt der CLI:** eigener Zufalls-Port auf `127.0.0.1`, Bearer-Token
  mit timing-sicherem Vergleich, Host-Header-Allowlist (Schutz vor DNS-Rebinding).
  Er öffnet keinen neuen Netzwerkzugang und erlaubt nichts, was der lokale
  Benutzer nicht ohnehin dürfte.
- **Kill-Switch:** wie im Desktop-Betrieb — `remote.disable` widerruft alle Geräte
  und stoppt Gateway + Tunnel.

## Dauerbetrieb

**Linux (systemd, User-Unit):** Electron braucht auch headless einen Display-Server —
auf Servern ohne X/Wayland `xvfb-run` vorschalten.

```ini
# ~/.config/systemd/user/vertragus-headless.service
[Unit]
Description=Vertragus Headless Host
After=network-online.target

[Service]
WorkingDirectory=%h/vertragus
Environment=VERTRAGUS_HEADLESS=1
ExecStart=/usr/bin/xvfb-run -a %h/vertragus/node_modules/.bin/electron .
Restart=on-failure
TimeoutStopSec=15

[Install]
WantedBy=default.target
```

`systemctl --user enable --now vertragus-headless` (bei Server-Logins ohne Sitzung:
`loginctl enable-linger $USER`). systemd sendet SIGTERM; der Host fährt geordnet
herunter (Session-Flush, Agents, Gateway, Tunnel, max. 8 s).

**Windows (Aufgabenplanung):** Aufgabe „Bei Anmeldung“ mit Aktion
`cmd /c "cd /d C:\git\vertragus && pnpm run headless"` (oder direkt
`node scripts\headless.mjs`), „Unabhängig von Benutzeranmeldung ausführen“ nur
mit Bedacht — safeStorage/DPAPI braucht das Benutzerprofil. Beenden über
`pnpm run headless -- status`/Task-Ende; die CLI räumt den Prozessbaum auf.
