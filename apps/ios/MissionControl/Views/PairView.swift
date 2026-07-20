//
//  PairView.swift
//  Mission Control
//

import SwiftUI

struct PairView: View {
    @EnvironmentObject private var client: RemoteClient
    @State private var baseURL = ""
    @State private var code = ""
    @State private var deviceName = UIDevice.current.name
    @State private var showScanner = false
    @State private var pairing = false

    private var canPair: Bool {
        !baseURL.trimmingCharacters(in: .whitespaces).isEmpty &&
        !code.trimmingCharacters(in: .whitespaces).isEmpty &&
        !deviceName.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    brand
                    VStack(spacing: 6) {
                        Text("Mission Control koppeln").font(.title2.bold())
                        Text("Scanne den QR-Code im Desktop oder trage Server-URL und Pairing-Code ein.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }

                    Button { showScanner = true } label: {
                        Label("QR-Code scannen", systemImage: "qrcode.viewfinder")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)

                    VStack(alignment: .leading, spacing: 12) {
                        field("Server-URL", text: $baseURL, placeholder: "https://…trycloudflare.com", keyboard: .URL)
                        field("Pairing-Code", text: $code, placeholder: "Einmal-Code", keyboard: .asciiCapable)
                        field("Gerätename", text: $deviceName, placeholder: "iPhone")
                    }

                    Button(action: pair) {
                        if pairing {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text("Sicher koppeln").frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canPair || pairing)

                    Text("Der Geräte-Token wird nur im Schlüsselbund gespeichert und nie an eine URL angehängt.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding()
            }
            .errorBanner(client)
            .sheet(isPresented: $showScanner) { scannerSheet }
            .onAppear { if baseURL.isEmpty { baseURL = client.lastBaseURLString } }
        }
    }

    private var brand: some View {
        VStack(spacing: 8) {
            Text("V")
                .font(.system(size: 44, weight: .bold, design: .serif))
                .frame(width: 76, height: 76)
                .background(Theme.verdigrisDeep, in: RoundedRectangle(cornerRadius: 18))
                .foregroundStyle(Theme.bronze)
            Eyebrow(text: "Vertragvs")
        }
        .padding(.top, 24)
    }

    private func field(
        _ label: String,
        text: Binding<String>,
        placeholder: String,
        keyboard: UIKeyboardType = .default
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Eyebrow(text: label)
            TextField(placeholder, text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(keyboard)
                .padding(10)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private var scannerSheet: some View {
        NavigationStack {
            QRScannerView { value in handleScan(value) }
                .ignoresSafeArea()
                .navigationTitle("QR scannen")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Abbrechen") { showScanner = false }
                    }
                }
        }
    }

    private func handleScan(_ value: String) {
        if let link = PairingLink(scanned: value) {
            baseURL = link.baseURLString
            if let scannedCode = link.code { code = scannedCode }
        } else {
            code = value
        }
        showScanner = false
        if canPair { pair() }
    }

    private func pair() {
        pairing = true
        Task {
            await client.pair(
                baseURLString: baseURL.trimmingCharacters(in: .whitespaces),
                code: code.trimmingCharacters(in: .whitespaces),
                deviceName: deviceName.trimmingCharacters(in: .whitespaces)
            )
            pairing = false
        }
    }
}
