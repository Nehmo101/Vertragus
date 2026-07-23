//
//  ChangesView.swift
//  Mission Control
//
//  Diff & Merge Center from snapshot.integration. Parity with the PWA `Changes`.
//

import SwiftUI

struct ChangesView: View {
    @EnvironmentObject private var client: RemoteClient
    @State private var diff: DiffSheet?

    private var workspaces: [OrchestratorSnapshot] {
        client.orderedSnapshots.filter { snapshot in
            guard let integration = snapshot.integration, snapshot.workspaceSessionId != nil else { return false }
            return !integration.items.isEmpty || integration.status != "idle"
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if workspaces.isEmpty {
                    EmptyStateView(
                        title: "Noch keine Integrationen",
                        message: "Verifizierte Commits erscheinen hier ohne Host-Worktree-Pfade."
                    )
                } else {
                    List {
                        ForEach(workspaces) { snapshot in
                            ChangesSection(snapshot: snapshot, showDiff: loadDiff)
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Merge")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ConnectionBadge(connected: client.connected)
                }
            }
            .errorBanner(client)
            .sheet(item: $diff) { DiffView(sheet: $0) }
        }
    }

    private func loadDiff(profileId: String, sessionId: String, taskId: String, title: String) {
        Task {
            do {
                let result = try await client.command(.taskDiff, TaskArgs(
                    profileId: profileId, sessionId: sessionId, taskId: taskId
                ))
                diff = DiffSheet(title: title, value: result?.diff ?? "Kein Diff.")
            } catch {
                client.errorMessage = RemoteClient.message(from: error)
            }
        }
    }
}

private struct ChangesSection: View {
    let snapshot: OrchestratorSnapshot
    let showDiff: (String, String, String, String) -> Void
    @EnvironmentObject private var client: RemoteClient

    private var scope: ScopeArgs? {
        guard let profileId = snapshot.profileId, let sessionId = snapshot.workspaceSessionId else { return nil }
        return ScopeArgs(profileId: profileId, sessionId: sessionId)
    }

    private var publication: ApprovalItem? {
        snapshot.pendingApprovals?.first { $0.kind == .prPublication }
    }

    var body: some View {
        Section {
            ForEach(snapshot.integration?.items ?? []) { item in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(item.title).font(.subheadline.weight(.semibold))
                        Spacer()
                        if let ci = item.remoteCiStatus {
                            Pill(text: "CI \(ci.rawValue)", color: Theme.ciColor(ci))
                        }
                    }
                    Text("\(item.status) · \(item.commit.map { String($0.prefix(10)) } ?? "kein Commit")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if client.capabilities().contains(Capability.diff), let scope {
                        Button("Diff") { showDiff(scope.profileId, scope.sessionId, item.taskId, item.title) }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .font(.caption)
                    }
                }
                .padding(.vertical, 2)
            }
            if let publication, let scope {
                HStack(spacing: 8) {
                    Button("Geprüft veröffentlichen") {
                        client.run(.publicationApprove, PublicationArgs(
                            profileId: scope.profileId, sessionId: scope.sessionId, planId: publication.task?.planId
                        ))
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    Button("Ablehnen") {
                        client.run(.publicationReject, PublicationArgs(
                            profileId: scope.profileId, sessionId: scope.sessionId, planId: publication.task?.planId
                        ))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                .font(.caption)
            }
        } header: {
            VStack(alignment: .leading, spacing: 2) {
                Eyebrow(text: snapshot.integration?.status ?? "")
                Text(snapshot.goal?.title ?? snapshot.profileId ?? "Workspace")
                    .font(.headline)
                    .textCase(nil)
            }
        }
    }
}
