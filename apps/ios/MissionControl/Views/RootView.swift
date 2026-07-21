//
//  RootView.swift
//  Mission Control
//
//  Pairing gate plus the five-tab command center (parity with the PWA bottom nav).
//

import SwiftUI

enum Tab: Hashable {
    case live, inbox, changes, goal, devices

    init?(route: String) {
        if route.contains("approvals") { self = .inbox }
        else if route.contains("changes") { self = .changes }
        else if route.contains("goal") { self = .goal }
        else if route.contains("live") { self = .live }
        else { return nil }
    }
}

struct RootView: View {
    @EnvironmentObject private var client: RemoteClient
    @ObservedObject private var push = PushRegistrar.shared
    @State private var tab: Tab = .live

    var body: some View {
        if client.isPaired {
            TabView(selection: $tab) {
                LiveView()
                    .tabItem { Label("Live", systemImage: "bolt.horizontal.circle") }
                    .tag(Tab.live)
                InboxView()
                    .tabItem { Label("Inbox", systemImage: "checkmark.seal") }
                    .badge(client.approvals.count)
                    .tag(Tab.inbox)
                ChangesView()
                    .tabItem { Label("Merge", systemImage: "arrow.triangle.merge") }
                    .tag(Tab.changes)
                GoalView()
                    .tabItem { Label("Ziel", systemImage: "plus.circle") }
                    .tag(Tab.goal)
                DevicesView()
                    .tabItem { Label("Geräte", systemImage: "shield.lefthalf.filled") }
                    .tag(Tab.devices)
            }
            .task { client.bootstrap() }
            .onChange(of: push.requestedRoute) { route in
                guard let route, let target = Tab(route: route) else { return }
                tab = target
                push.requestedRoute = nil
            }
        } else {
            PairView()
        }
    }
}
