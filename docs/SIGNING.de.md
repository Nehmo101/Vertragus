Deutsch | [English](SIGNING.md)

# Signierung und Notarisierung

## Vertragus wird unsigniert ausgeliefert — mit Absicht

Nichts Veröffentlichtes trägt eine Code-Signatur, und das ist eine
Entscheidung, keine Lücke, die auf Füllung wartet. Zertifikate sind
laufende Kosten (ein Abo bei einer Windows-Zertifizierungsstelle plus
99 USD pro Jahr für einen Apple-Developer-Account), die dieses Projekt
nicht trägt.

Was das für dich bedeutet:

- **Windows:** SmartScreen unterbricht den ersten Start eines
  heruntergeladenen Installers mit „Der Computer wurde durch Windows
  geschützt". Klicke **Weitere Informationen → Trotzdem ausführen**. Wenn
  du sicher gehen willst, prüfe den Download vorher — siehe unten.
- **Linux:** AppImage und deb sind unsigniert, wie die meisten unabhängig
  veröffentlichten Linux-Builds. Prüfe den Hash auf demselben Weg.
- **macOS:** Releases enthalten **überhaupt keine Mac-Dateien**. Bau die
  App selbst aus einem Checkout (`pnpm install && pnpm run build:mac`). Der
  Grund steht unten in einem eigenen Abschnitt — ein unsigniertes
  Mac-Release wäre schlechter als gar keins.

Die Signier-Maschinerie ist vollständig implementiert und schläft: Sollten
je Zertifikate auftauchen, ist das Hinterlegen der Repository-Secrets der
einzige Schritt. Solange die Secrets fehlen, läuft, warnt und bremst nichts
davon einen Build.

## Einen Download prüfen

Jedes Release trägt die Update-Kanal-Metadaten, die electron-builder
erzeugt (`latest.yml` für getaggte Releases, `main.yml` für Prereleases des
`main`-Kanals, dazu plattformspezifische Varianten). Jede listet die
Dateien des Releases mit ihrem **sha512 in base64** — genau dem Wert, den
auch der Auto-Updater vor der Installation prüft. So prüfst du einen
manuellen Download dagegen:

```bash
# macOS / Linux / Git Bash unter Windows
openssl dgst -sha512 -binary Vertragus-<version>-setup.exe | openssl base64 -A
```

```powershell
# PowerShell 7+
$hash = (Get-FileHash -Algorithm SHA512 .\Vertragus-<version>-setup.exe).Hash
[Convert]::ToBase64String([Convert]::FromHexString($hash))
```

Vergleiche die Ausgabe mit dem `sha512:`-Eintrag dieser Datei in der
`latest.yml` / `main.yml` des Releases. Eine Abweichung heißt: Der Download
ist beschädigt oder nicht die Datei, die das Release veröffentlicht hat —
dann nicht ausführen.

Das ist die ehrliche Sicherheitsgeschichte eines unsignierten Builds: Der
Hash beweist, dass die Datei dem entspricht, was der öffentliche CI-Lauf
erzeugt hat, und der Build ist aus einem öffentlichen Commit
reproduzierbar. Eine Signatur würde dasselbe beweisen, nur ohne den
manuellen Schritt.

## Warum es kein macOS-Release gibt

Squirrel.Mac — das Framework hinter Electrons Auto-Updater auf macOS —
**verweigert Updates, die nicht gültig signiert sind**. Ein unsigniertes
macOS-Release würde sich einmal installieren und danach nie wieder
aktualisieren: ein toter Updater in Gestalt einer funktionierenden App,
ausgerechnet auf der Plattform, auf der Nutzer unsichtbare Updates
erwarten. Nichts auszuliefern ist die ehrlichere Option.

Der Release-Workflow **baut** macOS trotzdem bei jedem Lauf, damit
Packaging-Fehler auffallen, und veröffentlicht diese Artefakte einfach nie.
Lokales `pnpm run build:mac` erzeugt dieselbe App; Gatekeeper stellt sie
unter Quarantäne, was `xattr -dr com.apple.quarantine
/Applications/Vertragus.app` für einen selbst kompilierten Build aufhebt.

## Was der Workflow erwartet, falls doch signiert wird

Signierung hängt ausschließlich an Repository-Secrets. Nicht existierende
Secrets kommen im Workflow als leere Strings an, deshalb behandelt der
Release-Workflow (`.github/workflows/release.yml`, Schritt „Detect signing
secrets") eine Plattform nur dann als signierfähig, wenn ihr **vollständiger**
Satz nicht leer ist — alles darunter baut unsigniert, genau wie heute (mit
einer Workflow-Warnung, wenn der Satz nur teilweise gesetzt ist).

### Windows — Azure Trusted Signing

| Secret | Bedeutung |
| --- | --- |
| `AZURE_TENANT_ID` | Entra-ID-Tenant des Service Principals |
| `AZURE_CLIENT_ID` | Service-Principal-Id (App-Registrierung) |
| `AZURE_CLIENT_SECRET` | Secret des Service Principals |
| `AZURE_CODE_SIGNING_ENDPOINT` | Endpoint-URI des Trusted-Signing-Kontos (regionsabhängig) |
| `AZURE_CODE_SIGNING_ACCOUNT_NAME` | Name des Trusted-Signing-Kontos |
| `AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME` | Zertifikatsprofil in diesem Konto |

Die ersten drei liest die `EnvironmentCredential` des
TrustedSigning-PowerShell-Moduls; die letzten drei reicht
`scripts/azure-sign.mjs` an `Invoke-TrustedSigning` weiter — der
`win.signtoolOptions.sign`-Hook in `electron-builder.yml`. Den Hook gibt es,
weil das native `win.azureSignOptions` von electron-builder 26 schon bei
bloßer Konfigurations-Präsenz aktiv wird und jeden zertifikatslosen Build
scheitern ließe; der Hook hält das Gate in der Umgebung und macht laut
hörbar nichts, wenn die Variablen fehlen.

### macOS — Developer ID + Notarisierung

| Secret | Bedeutung |
| --- | --- |
| `CSC_LINK` | Developer-ID-Application-Zertifikat, base64-kodierte `.p12` |
| `CSC_KEY_PASSWORD` | Passwort dieser `.p12` |
| `APPLE_ID` | Apple-ID, der das App-spezifische Passwort gehört |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-spezifisches Passwort für `notarytool` |
| `APPLE_TEAM_ID` | Developer-Team-Id |

electron-builder nutzt `CSC_*` zum Signieren; `mac.notarize: true` in
`electron-builder.yml` reicht den Build über die `APPLE_*`-Variablen an
Apples Notary-Service und heftet das Ticket an die App. Die
Hardened-Runtime-Entitlements liegen in `build/entitlements.mac.plist` (JIT,
unsignierter ausführbarer Speicher, Library Validation aus — Electron und
das native Binding von node-pty brauchen alle drei).

### Verifikation gehört zum Build

Wenn Signierung aktiv ist, beweist der Workflow vor dem Upload, dass sie
gegriffen hat: `Get-AuthenticodeSignature` muss beim Windows-Installer
`Valid` melden, und unter macOS wird das gebaute dmg gemountet und die App
darin muss `spctl -a -vv -t execute` und `xcrun stapler validate` bestehen.
Ein signierfähiger Build, der unsignierte Artefakte erzeugt hat, scheitert
laut, statt auszuliefern.

## Der kostenlose Weg, falls er je gewünscht ist

Nur für Windows: [SignPath Foundation](https://signpath.org/) stellt
qualifizierten Open-Source-Projekten kostenlose OV-Signaturzertifikate aus
und hält den Schlüssel im eigenen HSM, sodass nichts Geheimes in dieses
Repository wandert. Der Preis dafür: Als Herausgeber steht in
Windows-Dialogen „SignPath Foundation" statt des Projekts, Anträge dauern
Tage bis Wochen, und das Zertifikat würde den Azure-Weg oben ersetzen (eine
kleine Änderung in `scripts/azure-sign.mjs`). Für macOS gibt es kein
Äquivalent: Apples 99 USD pro Jahr sind der einzige Weg zu einem
notarisierten Mac-Build.

Wann immer ein erstes signiertes Release stattfindet, gehört ein Nachzug
dazu: `publisherName` für den Windows-Updater festzurren, damit installierte
Apps prüfen, dass jedes künftige Update denselben Herausgeber trägt. Dieser
Pin muss **nach** dem ersten signierten Release landen, nie davor — er wird
in die installierte App eingebacken und lässt sie jedes Update ohne diese
Signatur ablehnen; eine App, die während unsignierter Releases gepinnt
wurde, könnte sich nie wieder aktualisieren.
