Deutsch | [English](CHROMIUM-EXTENSION.md)

# Vertragus Chromium-Erweiterung

Eine ungepackte Manifest-V3-Erweiterung, die mit dem Vertragus-Panel
paired, damit ein **Worker** (oder sein Helper) eine laufende Web-App in
den Tabs testen kann, die du schon offen hast — inklusive eingeloggter
Sitzungen.

Das ist **kein** zweiter MCP-Server und kein Extra-MCP. Worker rufen
`browser_*`-Tools auf ihrer bestehenden Vertragus-Identität auf. Die
Erweiterung öffnet einen Loopback-WebSocket auf demselben HTTP-Listener
wie `/mcp`, Pfad `/browser`. Siehe Handbuch Phase H in
[`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md). Threat-Model:
[`SECURITY.md`](../SECURITY.md).

## Was sie ist

Das Panel minted einen Pairing-Token (256-bit Hex) und zeigt eine URL:

```
http://127.0.0.1:<port>/browser?token=<token>
```

Die Erweiterung fügt diese URL ein, verbindet mit
`ws://127.0.0.1:…/browser?token=…` und führt Befehle in echten Tabs aus
(`tabs`, `navigate`, Snapshot/Click/Fill/Press, `screenshot`). Eine
getrennte Erweiterung ist ein Tool-Fehler (`browser_disconnected`), nie
ein stilles Überspringen.

`chrome-extension:`-Origins werden **nur** auf `/browser` akzeptiert.
`/mcp` lehnt sie weiter ab (DNS-Rebinding-Abwehr bleibt für Agent-CLIs
eng).

## Laden und pairen

1. **Einstellungen → Browser-Erweiterung** öffnen und die Pairing-URL
   kopieren.
2. In Chromium: `chrome://extensions` → Entwicklermodus → **Entpackt
   laden**.
3. Auf den Ordner zeigen, den Settings zeigt (`extensions/chromium` im
   Dev-Checkout, `chromium-extension` neben der gepackten App).
4. Das Popup der Erweiterung öffnen, Pairing-URL einfügen, verbinden.
5. Die Settings-Pille wird verbunden. Ein Worker kann dann
   `browser_status` rufen.

Token in Settings rotieren, wenn die URL geleakt ist — das trennt die
Erweiterung und ändert die URL. Der Token ist kein schreibbarer
`settings:set`-Key.

## Tools, die Worker bekommen

| Tool | Was es tut |
| --- | --- |
| `browser_status` | Verbunden? Wie viele Clients? Zuerst rufen. |
| `browser_tabs` | Offene Tabs, die die Erweiterung fahren kann. |
| `browser_navigate` | Tab unter einer http(s)-URL öffnen oder wiederverwenden. |
| `browser_snapshot` | Accessibility-Baum mit Refs (`e1`, `e2`, …). |
| `browser_click` / `browser_fill` / `browser_press` | Auf eine Snapshot-Ref wirken. |
| `browser_screenshot` | Sichtbares-Tab-PNG als Base64 im JSON-Result. |

Orchestratoren und Leads bekommen diese Tools **nicht**. Sie delegieren.
Nach Navigation oder großer DOM-Änderung einen frischen Snapshot nehmen.

## Was sie nicht ist

- Kein Extra-MCP (`extraMcp` an einem Slot bindet weiter einen
  Drittanbieter-Server für andere Tools).
- Kein Playwright, keine Headless-Session, keine Sandbox: sie fährt
  **dein** Chromium.
- Nicht remote: die Bridge ist loopback-only. Der Handy-Composer kann sie
  nicht öffnen.
- Kein Peer-to-Peer: Helper nutzen dieselbe Bridge, sie sprechen nicht
  miteinander.

## Sicherheit

Ein Yolo-Worker kann klicken, tippen und jeden Tab screenshotten, den die
Erweiterung sieht. Nur pairen, während du den Lauf beobachtest. Entpairen
oder den Token rotieren, wenn du fertig bist. Host-Permissions decken
http(s) ab, damit das Content-Script die Seite snapshoten kann, die du
den Worker testen lässt — das ist der Punkt, und der Wirkradius.
