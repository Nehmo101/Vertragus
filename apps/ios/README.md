# Vertragus Mission Control — iOS

Native SwiftUI client for the Vertragus Remote Gateway. It is a new authenticated
client against the **existing** gateway (`src/main/remote/`), mirroring the PWA
(`apps/mobile/`): live DAG, approval inbox, diff/merge, goal submission (with voice),
devices/kill-switch — plus native niceties the PWA can't offer on iOS: QR-scan
pairing, Keychain token storage, a configurable server URL, and background APNs push.

No third-party dependencies — only Apple frameworks (SwiftUI, URLSession,
AVFoundation, UserNotifications, Security).

## Build

The Xcode project is generated from `project.yml` with [XcodeGen](https://github.com/yonyz/XcodeGen)
so reviews stay text-based (`MissionControl.xcodeproj` is gitignored).

```sh
brew install xcodegen        # once
cd apps/ios
xcodegen generate            # writes MissionControl.xcodeproj
open MissionControl.xcodeproj # or: xcodebuild -scheme MissionControl -destination 'generic/platform=iOS' build
```

Set your Apple Developer **Team** and a unique **bundle identifier** in Xcode
(Signing & Capabilities) or via `DEVELOPMENT_TEAM` / `PRODUCT_BUNDLE_IDENTIFIER`
in `project.yml`. Deployment target is iOS 16.

## Run / pair

1. On the desktop, enable Mission Control (Remote) and start the tunnel.
2. In the desktop pairing dialog, either scan the QR with this app (it captures both
   the tunnel URL and the one-time code in one scan) or type the **Server-URL** (the
   tunnel origin, e.g. `https://<name>.trycloudflare.com`) and the **Pairing-Code**.
3. The bearer token is stored only in the Keychain; the server URL and device record
   live in `UserDefaults`.

## Notifications (APNs)

Background push requires the **desktop** to be configured with an Apple APNs signing
key (the desktop is the sender — Vertragus is peer-to-peer, there is no central
server). In the desktop Remote panel, set Team ID, Key ID, the `.p8` key, the bundle
identifier and the environment (sandbox/production). Then tap *"Push aktivieren"* in
the app's Geräte tab. Without APNs configured, the app still works fully — live state
streams over WebSocket/SSE while the app is foregrounded (in-app badges).

The app registers its APNs token via `POST /push/apns { token, environment, bundleId }`
(capability `push`). `aps-environment` in `MissionControl.entitlements` is `development`
for local builds; App Store / TestFlight distribution maps push to production
automatically.

## Verify

- **Unit tests:** `xcodebuild -scheme MissionControl -destination 'platform=iOS Simulator,name=iPhone 15' test`
  covers contract decoding, command-envelope encoding, SSE/QR parsing, URL normalization.
- **End-to-end:** run the desktop with `corepack pnpm dev`, enable Remote (quick tunnel
  is fine for dev), point the app's Server-URL at the tunnel, pair, and confirm the Live
  DAG mirrors the desktop. Approve a plan, send a goal, open a diff, set budget caps,
  then hit the master kill-switch and confirm the live stream drops within seconds.

## Notes / follow-ups

- Strings are currently German-inline (like the PWA). Extracting them into
  `Localizable.strings` with an English fallback is a straightforward follow-up.
- Voice dictation uploads an AAC (`audio/mp4`) clip to `/speech/transcribe`; if the
  desktop's speech backend only accepts specific container types, adjust the recorder
  format in `Views/GoalView.swift`.
- The contract structs in `Model/Contracts.swift` are hand-ported from
  `src/shared/remote.ts` and `src/shared/orchestrator.ts` — keep them in sync when the
  shared contract changes.
