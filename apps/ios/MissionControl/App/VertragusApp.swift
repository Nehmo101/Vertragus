//
//  VertragusApp.swift
//  Mission Control
//

import SwiftUI

@main
struct VertragusApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var client = RemoteClient()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(client)
                .tint(Theme.bronze)
                .onAppear {
                    appDelegate.onDeviceToken = { hex in
                        PushRegistrar.shared.lastDeviceTokenHex = hex
                        Task { await client.registerApns(deviceToken: hex) }
                    }
                }
        }
    }
}
