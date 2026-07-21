//
//  InboxView.swift
//  Mission Control
//
//  Approval inbox rendered from the server's `approvals` frame, with kind-specific
//  actions and a read-only diff viewer. Parity with the PWA `Inbox`.
//

import SwiftUI

struct DiffSheet: Identifiable {
    let id = UUID()
    let title: String
    let value: String
}

struct InboxView: View {
    @EnvironmentObject private var client: RemoteClient
    @State private var diff: DiffSheet?

    var body: some View {
        NavigationStack {
            Group {
                if client.approvals.isEmpty {
                    EmptyStateView(
                        title: "Alles entschieden",
                        message: "Es wartet derzeit kein Plan und keine blockierte Aufgabe."
                    )
                } else {
                    List {
                        ForEach(client.approvals) { approval in
                            ApprovalRow(approval: approval, showDiff: loadDiff)
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Inbox")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ConnectionBadge(connected: client.connected)
                }
            }
            .errorBanner(client)
            .sheet(item: $diff) { sheet in DiffView(sheet: sheet) }
        }
    }

    private func loadDiff(_ approval: ApprovalItem) {
        guard let task = approval.task else { return }
        Task {
            do {
                let result = try await client.command(.taskDiff, TaskArgs(
                    profileId: approval.profileId,
                    sessionId: approval.workspaceSessionId,
                    taskId: task.id
                ))
                diff = DiffSheet(title: task.title, value: result?.diff ?? "Kein Diff.")
            } catch {
                client.errorMessage = RemoteClient.message(from: error)
            }
        }
    }
}

private struct ApprovalRow: View {
    let approval: ApprovalItem
    let showDiff: (ApprovalItem) -> Void
    @EnvironmentObject private var client: RemoteClient

    private var scope: ScopeArgs {
        ScopeArgs(profileId: approval.profileId, sessionId: approval.workspaceSessionId)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Pill(text: kindLabel, color: kindColor)
            Text(approval.title).font(.subheadline.weight(.semibold))
            Text(approval.summary).font(.caption).foregroundStyle(.secondary)
            if approval.task != nil {
                Button("Diff ansehen") { showDiff(approval) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .font(.caption)
            }
            HStack(spacing: 8) { actions }.font(.caption)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var actions: some View {
        switch approval.kind {
        case .toolPermission:
            if let permission = approval.permission {
                primary("Einmal erlauben") {
                    client.run(.permissionAllow, PermissionArgs(
                        profileId: approval.profileId,
                        sessionId: approval.workspaceSessionId,
                        permissionId: permission.id
                    ))
                }
                secondary("Ablehnen") {
                    client.run(.permissionDeny, PermissionArgs(
                        profileId: approval.profileId,
                        sessionId: approval.workspaceSessionId,
                        permissionId: permission.id
                    ))
                }
            }
        case .planReview:
            primary("Freigeben") { client.run(.planApprove, scope) }
            secondary("Ablehnen") { client.run(.planReject, scope) }
        case .prPublication:
            primary("Veröffentlichen") { client.run(.publicationApprove, scope) }
            secondary("Ablehnen") { client.run(.publicationReject, scope) }
        case .providerLimit:
            if let task = approval.task {
                primary("Sicherer Fallback") {
                    client.run(.taskFallback, TaskArgs(
                        profileId: approval.profileId,
                        sessionId: approval.workspaceSessionId,
                        taskId: task.id
                    ))
                }
            }
            secondary("Lauf zurücksetzen") { client.run(.runReset, scope) }
        case .budgetExceeded:
            Text("Caps im Live-Tab anpassen und pausierte Tasks dort fortsetzen.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        case .taskBlocked, .unknown:
            primary("Auto aktivieren") { client.run(.modeEnableAuto, scope) }
            secondary("Lauf zurücksetzen") { client.run(.runReset, scope) }
        }
    }

    private func primary(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action).buttonStyle(.borderedProminent).controlSize(.small)
    }

    private func secondary(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action).buttonStyle(.bordered).controlSize(.small)
    }

    private var kindLabel: String {
        switch approval.kind {
        case .planReview: return "Plan-Review"
        case .prPublication: return "PR-Veröffentlichung"
        case .toolPermission: return "Tool-Berechtigung"
        case .budgetExceeded: return "Budget erreicht"
        case .providerLimit: return "Provider-Limit"
        case .taskBlocked: return "Blockiert"
        case .unknown: return "Entscheidung"
        }
    }

    private var kindColor: Color {
        switch approval.kind {
        case .planReview: return Theme.bronze
        case .prPublication: return Theme.verdigris
        case .toolPermission: return .purple
        case .budgetExceeded, .providerLimit: return .orange
        case .taskBlocked, .unknown: return .red
        }
    }
}

struct DiffView: View {
    let sheet: DiffSheet
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView([.horizontal, .vertical]) {
                Text(sheet.value)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(sheet.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Schließen") { dismiss() }
                }
            }
        }
    }
}
