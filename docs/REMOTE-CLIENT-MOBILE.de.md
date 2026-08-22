Deutsch | [English](REMOTE-CLIENT-MOBILE.md)

# Remote-Client (Handy / Tailscale)

Analyse des bisherigen Tailgate-Clients, was dieser PR ändert, und was
danach bewusst offen bleibt. Der Client lebt in `src/remoteClient` und
wird als `out/remote` vom Remote-Server ausgeliefert.

## Was bisher schiefging

Der Client war ein **herunterskaliertes Desktop-Panel**, kein Phone-UI.

### Lesbarkeit

- Eigene Farbwelt (`#0f1512`, grelles Verdigris), nicht die
  Bronze/Graphit-Sprache des Panels. Figtree/JetBrains Mono waren
  referenziert, aber **nicht geladen** — System-UI, 16px-Felder fehlten.
- Ziel, Aufgabe und Orchestrator-Fragen lagen in **einer Zeile mit
  Ellipsis** (`white-space: nowrap`). Auf 390 px Breite unlesbar.
- Agenten waren **Chips ohne Status**. `statusText` kam vom Host schon
  mit, der Typ und die UI haben es ignoriert. Working/Waiting sahen
  gleich aus, außer Stopped war transparent.
- Die `?`-Badges waren 20×20 px (Apple HIG: 44 px). Fragen an den
  Menschen waren ein grauer Einzeiler, kein Banner.
- Feste 12,5 px Terminalschrift, keine A+/A−-Stufe.

### Scrollen

Ursache, nicht „zu viel Inhalt":

1. `html, body, #root, .app { height: 100% }` hat die Seite auf die
   Viewport-Höhe **festgenagelt**.
2. `.workspace-list { flex: 1; overflow-y: auto }` war der vorgesehene
   Scroller, aber **ohne `min-height: 0`**. Flex-Kinder schrumpfen dann
   nicht; `overflow-y: auto` greift nie.
3. iOS Safari pans **Dokument-Scroll** zuverlässig, innere Overflow-Boxen
   oft nicht — und `-webkit-overflow-scrolling` fehlte.
4. Safe-Area hing fälschlich am Header-**unten**; die Liste hatte keinen
   unteren Inset. Die Software-Tastatur (`visualViewport`) wurde ignoriert,
   Composer und Terminal-Leiste lagen unter den Keys.

### Kopplungs-Link bei jedem Neustart neu

Kein UI-Bug. In `createRemoteController`:

- Mit OS-Schlüsselbund: Token encrypted in `vertragus-v2.json`.
- **Ohne Schlüsselbund** (häufig Linux, und Windows/macOS wenn
  `safeStorage` beim Boot noch nicht entsperrt ist): Token nur im RAM.
  Jeder Start hat `if (!token()) persistToken(mintPairingToken())`
  ausgeführt — neuer QR, altes Handy tot.
- Selbst bei gleichem Token: Sessions leben nur im Prozess. Nach einem
  Desktop-Neustart bekam das Handy `session_revoked`, der Hash war aber
  schon aus der URL gestrichen (`sessionStorage`). Erneut scannen.

## Was dieser PR tut

| Thema | Änderung |
| --- | --- |
| Stabiler Link | Token zusätzlich in `userData/remote-pairing.token` (0600). Nie still überschreiben, wenn Ciphertext nicht entsperrt. `Regenerate` bleibt der einzige Rotationsweg. |
| Handy bleibt gekoppelt | Pairing-Token + Session in `localStorage`. Nach Desktop-Restart: stilles Re-Pair über den gespeicherten Token. |
| Scrollen | Dokument-Scroll, sticky Header, kein inneres Overflow auf der Liste. Terminal als `position: fixed` auf `visualViewport.height`. |
| Lesen | 17 px Body, 16 px Inputs, Ziele umbrechen, Agentenzeilen mit Rolle·Status, 44 px Touch, Warn-Banner für `ask_user`. |
| Brand | Caprasimo/Figtree/JetBrains Mono, Bronze/Verdigris, Fusione-Marke. |
| Terminal | Größere Default-Schrift, A+/A−, Esc/Tab/Enter/Ctrl-C/Pfeile, kein Auto-Focus der versteckten xterm-Textarea auf dem Handy. |

Die Gateway-Allow-List bleibt bei sechs Verben. Kein Promote, keine
Settings, keine CLI-Permission-TUIs auf dem Handy.

## Design-Ideen (umgesetzt vs. später)

### Jetzt drin, weil sie das Handy benutzbar machen

- Karten auf-/zuklappen; beendete Workspaces hinter einem Toggle.
- Startformular als `<details>`, zu wenn schon ein Lauf lebt.
- Stop erst nach zweitem Tap.
- Sticky Header mit Verbindungsstatus.
- Locale aus `hello.locale`.

### Nächste Stufe, ohne Allow-List zu erweitern

- **PWA-Manifest + Icon**, „Zum Home-Bildschirm" — der stabile Link macht
  das erst sinnvoll.
- **Pull-to-refresh** (das ⟳ bleibt).
- **Haptik** auf Stop / Antworten (`navigator.vibrate`).
- **Frage-Inbox** oben, unabhängig von der Karte — `ask_user` darf nicht
  unter dem Fold verschwinden.
- Terminal: optionales **Wrap** statt horizontales xterm-Scrollen;
  Snapshot-Suche.
- Light/Dark lokal überschreiben, statt nur dem Desktop zu folgen.

### Braucht ein neues Gateway-Verb — nicht in v1

- Promote / Worktree-Cleanup (bewusst Desktop-only, siehe Handbuch).
- CLI-Permission-Dialoge auf das Handy spiegeln (`ask-user`-Tier).
- Live-`statusText`-Push feiner als der Workspace-Summary-Takt.
- Retro / Briefing lesen.

### Nicht tun

- Zweiten MCP-Server oder Spiegel aller `APP_CHANNELS`.
- Raw-xterm als primäre Handy-Tastatur zurückbauen.
- Den Token in `electron-store` als Klartext legen.

## Der zweite Durchgang — von 3/10 in der Hand

Der erste Durchgang machte den Client lesbar. In der Hand, über Tailscale,
blieb er bei 3/10 — mit zwei Mängeln, die derjenige benannte, der das Gerät
hielt: durch den Terminal-Verlauf zu scrollen sei "beinahe unmöglich", und
wer ein Terminal verlässt, landet immer wieder ganz oben in der Übersicht.

### Beide Mängel hatten dieselbe Form

Keiner war ein Gesten-Problem. In beiden Fällen wurde dem Benutzer der
Zustand unter den Händen weggerissen.

- **Das Terminal wurde bei fast jedem Render neu gebaut.** `useRemote()`
  liefert ein frisches Objektliteral, `api` wechselte also bei jedem Render
  von `App` die Identität — und `App` rendert bei jedem `workspaces`-Push
  neu. Der Effekt, der das Terminal erzeugt und anhängt, führte `api` in
  seinen Abhängigkeiten: jeder Push verwarf das `Terminal`, hängte neu an
  und schrieb den Snapshot erneut. Hochscrollen funktionierte; der nächste
  Push warf den Lesenden wieder ans Ende. `A+`/`A−` löschte den Puffer
  durch dieselbe Tür.
- **Der Weg zurück hängte die ganze Übersicht ab.** `App` gab vorzeitig
  `<RemoteTerminal>` zurück und nahm dabei die Scroll-Position des
  Dokuments, die aufgeklappten Karten und jeden halb getippten Entwurf mit.
  Nur die Position wiederherzustellen hätte eines von drei Dingen geheilt —
  und sich mit der `history.scrollRestoration` des Browsers angelegt.

Die Korrekturen sind strukturell, nicht kosmetisch: das Terminal entsteht
einmal pro Agent und erreicht seine Props über Refs; die Übersicht bleibt
unter dem fixierten Terminal-Overlay montiert, versteckt statt abgehängt —
nichts wird wiederhergestellt, weil nichts verloren geht.

### Was der Client gewonnen hat

| Bereich | Änderung |
| --- | --- |
| Terminal-Verlauf | Touch-Scroller mit Nachlauf über die tatsächliche Zellhöhe, Sprung zur neuesten Ausgabe, Seiten- und Ende-Steuerung, Suche im Verlauf, Kopieren auch über einfaches HTTP (eine Tailnet-URL ist kein sicherer Kontext, `navigator.clipboard` fehlt dort), Schriftgröße 11–24 dauerhaft. |
| Übersicht | Fragen-Eingang über alle Workspaces mit Sprung aus dem Kopf, das Aufgabenboard, das die Leitung längst mitführte, deterministische Sortierung, Ziehen zum Aktualisieren, Alle-einklappen, lokale Darstellungswahl, Entwürfe, die jeden Wechsel überleben. |
| Navigation | Die Zurück-Geste schließt das Terminal, statt die App zu verlassen; ein History-Eintrag, ohne URL geschoben, damit das Kopplungs-Fragment entfernt bleibt. |
| Verbindung | Neuverbindung beim Aufwachen (Sichtbarkeit, `online`, bfcache) statt Abwarten der Backoff-Obergrenze; ein Socket, den der Browser noch `OPEN` nennt, wird per `refresh`-Umlauf als tot nachgewiesen; identische Pushes behalten ihre Array-Identität. Jede Wiederanmeldung eines Terminals nennt das Ende, das der Client schon hält, sodass die Leitung nur den Rest nachliefert statt des ganzen Scrollbacks; und eine Kopplung, die niemanden erreicht, wird von einer abgelehnten unterschieden — nur die abgelehnte führt zurück zum QR-Code, die unerreichbare wartet auf derselben Backoff-Treppe und versucht es beim Aufwachen erneut. |
| Rahmen | Installierbar (Manifest, maskierbares und Apple-Touch-Icon), WCAG-korrigierte Palette in beiden Themes, `prefers-contrast` und dynamische Schriftgrößen beachtet, die Visual-Viewport-Geometrie als dokumentierter Drei-Variablen-Vertrag veröffentlicht. |

### Was die Aufteilung gebracht hat

Aus dem einen Stylesheet des Clients wurden drei — Rahmen, Übersicht,
Terminal — jeweils der Komponente zugeordnet, die sie benutzt; und die
Entscheidungen wanderten aus den `.tsx`-Dateien in reine Module mit Tests.
Das ist keine Ordnungsliebe: dieses Projekt hat keinen DOM-Testlauf, Logik
innerhalb einer Komponente ist also von Bauart her ungetestet. Der
Scroll-Akkumulator, der Nachlauf, die Aggregation des Fragen-Eingangs, die
Gruppierung der Aufgaben, der History-Automat und das Reveal-Prädikat
werden jetzt in Tests verhandelt, nicht im Browser.
