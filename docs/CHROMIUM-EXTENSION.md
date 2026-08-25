English | [Deutsch](CHROMIUM-EXTENSION.de.md)

# Vertragus Chromium extension

An unpacked Manifest V3 extension that pairs with the Vertragus panel so a
**worker** (or its helper) can test a live web app in the tabs you already
have open — including logged-in sessions.

This is **not** a second MCP server and not extra MCP. Workers call
`browser_*` tools on their existing Vertragus identity. The extension
opens a loopback WebSocket on the same HTTP listener as `/mcp`, path
`/browser`. See handbook Phase H in
[`HANDBOOK-HARNESS.md`](./HANDBOOK-HARNESS.md). Threat model:
[`SECURITY.md`](../SECURITY.md).

## What it is

The panel mints a pairing token (256-bit hex) and shows a URL:

```
http://127.0.0.1:<port>/browser?token=<token>
```

The extension pastes that URL, connects with `ws://127.0.0.1:…/browser?token=…`,
and runs commands in real tabs (`tabs`, `navigate`, snapshot/click/fill/press,
`screenshot`). A disconnected extension is a tool error
(`browser_disconnected`), never a silent skip.

`chrome-extension:` origins are accepted **only** on `/browser`. `/mcp`
still refuses them (DNS-rebinding defence stays tight for agent CLIs).

## Load and pair

1. Open **Settings → Browser extension** and copy the pairing URL.
2. In Chromium: `chrome://extensions` → Developer mode → **Load unpacked**.
3. Point it at the folder Settings reveals (`extensions/chromium` in a
   dev checkout, `chromium-extension` next to the packaged app).
4. Open the extension popup, paste the pairing URL, connect.
5. The Settings pill turns connected. A worker can then call
   `browser_status`.

Rotate the token from Settings if the URL leaked — that disconnects the
extension and changes the URL. The token is not a writable `settings:set`
key.

## Tools workers get

| Tool | What it does |
| --- | --- |
| `browser_status` | Connected? How many clients? Call this first. |
| `browser_tabs` | Open tabs the extension can drive. |
| `browser_navigate` | Open or reuse a tab at an http(s) URL. |
| `browser_snapshot` | Accessibility tree with refs (`e1`, `e2`, …). |
| `browser_click` / `browser_fill` / `browser_press` | Act on a snapshot ref. |
| `browser_screenshot` | Visible-tab PNG as base64 in the JSON result. |

Orchestrators and leads do **not** get these tools. They delegate. Take a
fresh snapshot after navigation or a large DOM change.

## What it is not

- Not extra MCP (`extraMcp` on a slot still attaches a third-party server
  for other tools).
- Not Playwright, not a headless session, not a sandbox: it drives **your**
  Chromium.
- Not remote: the bridge is loopback-only. The phone composer cannot open
  it.
- Not peer-to-peer: helpers use the same bridge, they do not talk to each
  other.

## Security

A yolo-mode worker can click, type and screenshot any tab the extension
can see. Pair only while you are watching the run. Unpair or rotate the
token when you are done. Host permissions cover http(s) so the content
script can snapshot the page you asked the worker to test — that is the
point, and the blast radius.
