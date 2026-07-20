//
//  DevicesView.swift
//  Mission Control
//
//  Device list, native push enablement, master kill switch, and unpair.
//  Parity with the PWA `Devices` view.
//

import SwiftUI

struct DevicesView: View {
    @EnvironmentObject private var client: RemoteClient
    @ObservedObject private var push = PushRegistrar.shared
    @State private var confirmKill = false

    var body: some View {
        NavigationStack {
            List {
                Section("Geräte") {
                    if client.devices.isEmpty {
                        Text("Keine gekoppelten Geräte.").foregroundStyle(.secondary)
                    }
                    ForEach(client.devices) { device in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text("\(device.name) · \(device.actor.displayName)")
                                    .font(.subheadline.weight(.semibold))
                                Spacer()
                                Pill(
                                    text: device.isRevoked ? "widerrufen" : "aktiv",
                                    color: device.isRevoked ? .red : .green
                                )
                            }
                            Text("\(device.capabilities.joined(separator: " · ")) · \(device.scopes.count) Scope(s)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section("Benachrichtigungen") {
                    if client.capabilities().contains(Capability.push) {
                        Button { push.requestAndRegister() } label: {
                            Label("Push-Benachrichtigungen aktivieren", systemImage: "bell.badge")
                        }
                    }
                    Text("Native Push (APNs) benötigt eine im Desktop hinterlegte APNs-Konfiguration. In-App-Badges bleiben immer aktiv.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if let error = push.authorizationError {
                        Text(error).font(.caption).foregroundStyle(.red)
                    }
                }

                Section {
                    Button(role: .destructive) { confirmKill = true } label: {
                        Label("Master-Not-Aus", systemImage: "power")
                    }
                }

                Section {
                    Button(role: .destructive) { client.unpair() } label: {
                        Text("Kopplung aufheben")
                    }
                }
            }
            .navigationTitle("Geräte")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ConnectionBadge(connected: client.connected)
                }
            }
            .errorBanner(client)
            .refreshable { await client.loadDevices() }
            .confirmationDialog(
                "Alles stoppen und Tunnel/Gateway sofort niederreißen?",
                isPresented: $confirmKill,
                titleVisibility: .visible
            ) {
                Button("Master-Not-Aus", role: .destructive) {
                    client.run(.killSwitchActivate, EmptyArgs())
                }
                Button("Abbrechen", role: .cancel) {}
            }
        }
    }
}
