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
