//
//  LiveView.swift
//  Mission Control
//
//  Live DAG per workspace with budget, plan-approval hint, and capability-gated
//  task controls. Parity with the PWA Live tab (apps/mobile/src/App.tsx `Live`).
//

import SwiftUI

struct LiveView: View {
    @EnvironmentObject private var client: RemoteClient

    var body: some View {
        NavigationStack {
            Group {
                if client.orderedSnapshots.isEmpty {
                    EmptyStateView(
                        title: "Noch keine Live-Daten",
                        message: "Sobald ein Workspace läuft, erscheint sein DAG hier."
                    )
                } else {
                    List {
                        ForEach(client.orderedSnapshots) { snapshot in
                            WorkspaceSection(snapshot: snapshot)
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Live")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ConnectionBadge(connected: client.connected)
                }
            }
            .errorBanner(client)
        }
    }
}

private struct WorkspaceSection: View {
    let snapshot: OrchestratorSnapshot
    @EnvironmentObject private var client: RemoteClient
    @State private var maxTokens = ""
    @State private var maxCost = ""

    private var capabilities: [String] { client.capabilities() }
    private var scope: ScopeArgs? {
        guard let profileId = snapshot.profileId, let sessionId = snapshot.workspaceSessionId else { return nil }
        return ScopeArgs(profileId: profileId, sessionId: sessionId)
    }

    var body: some View {
        Section {
            if let budget = snapshot.budget { budgetCard(budget) }
            if capabilities.contains(Capability.budget), let scope { budgetForm(scope) }
            if let plan = snapshot.pendingPlan { pendingPlanRow(plan) }
            ForEach(snapshot.tasks) { task in
                TaskRow(task: task, scope: scope, capabilities: capabilities)
            }
        } header: {
            VStack(alignment: .leading, spacing: 2) {
                Eyebrow(text: snapshot.profileId ?? "Workspace")
                Text(snapshot.goal?.title ?? "Workspace bereit")
                    .font(.headline)
                    .textCase(nil)
            }
        }
    }

    private func budgetCard(_ budget: RemoteBudgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(Int(budget.tokens).formatted()) Token · $\(budget.costUsd, specifier: "%.2f")")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(budget.exceeded ? Color.red : Color.primary)
            Text("Caps: \(budget.caps.maxTokens.map { Int($0).formatted() } ?? "–") Token · $\(budget.caps.maxCostUsd.map { String(format: "%.2f", $0) } ?? "–")")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("Telemetrie \(budget.tasksReported ?? 0)/\(budget.tasksTotal ?? snapshot.tasks.count) · Token \(budget.tokenDataComplete == true ? "vollständig" : "teilweise") · Kosten \(budget.costDataComplete == true ? "vollständig" : "teilweise")")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func budgetForm(_ scope: ScopeArgs) -> some View {
        HStack {
            TextField("Token-Cap", text: $maxTokens).keyboardType(.numberPad)
            TextField("USD-Cap", text: $maxCost).keyboardType(.decimalPad)
            Button("Setzen") {
                client.run(.budgetSetCaps, BudgetArgs(
                    profileId: scope.profileId,
                    sessionId: scope.sessionId,
                    maxTokens: Int(maxTokens),
                    maxCostUsd: Double(maxCost.replacingOccurrences(of: ",", with: "."))
                ))
            }
            .buttonStyle(.bordered)
            .disabled(maxTokens.isEmpty && maxCost.isEmpty)
        }
        .font(.caption)
    }

    private func pendingPlanRow(_ plan: PendingPlanReview) -> some View {
        HStack {
            Label("Wartet auf Plan-Freigabe · \(plan.plan.tasks.count) Tasks", systemImage: "clock")
                .font(.caption)
                .foregroundStyle(Theme.bronzeDim)
            Spacer()
            if capabilities.contains(Capability.replan), plan.plan.maxParallel > 1, let scope {
                Button("Parallelität 1") {
                    client.run(.planReplan, ReplanArgs(
                        profileId: scope.profileId,
                        sessionId: scope.sessionId,
                        removeTaskIds: [],
                        maxParallel: 1
                    ))
                }
                .buttonStyle(.bordered)
                .font(.caption)
            }
        }
    }
}

private struct TaskRow: View {
    let task: VertragusTask
    let scope: ScopeArgs?
    let capabilities: [String]
    @EnvironmentObject private var client: RemoteClient

    private var subtitle: String? {
        let base = task.agentName ?? task.role
        guard let action = task.lastAction else { return base }
        return [base, action].compactMap { $0 }.joined(separator: " · ")
    }

    private var isLimit: Bool {
        let text = [task.note, task.judgeReason].compactMap { $0 }.joined(separator: " ").lowercased()
        return ["usage", "rate", "nutzungs", "quota", "limit"].contains { text.contains($0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(task.title).font(.subheadline.weight(.semibold))
                Spacer()
                Pill(text: task.status.rawValue, color: Theme.statusColor(task.status))
            }
            if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
            if let progress = task.progress {
                ProgressView(value: min(max(progress, 0), 100), total: 100).tint(Theme.verdigris)
            }
            if let scope { actions(scope) }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func actions(_ scope: ScopeArgs) -> some View {
        let args = TaskArgs(profileId: scope.profileId, sessionId: scope.sessionId, taskId: task.id)
        HStack(spacing: 8) {
            if capabilities.contains(Capability.taskControl), task.status == .running || task.status == .queued {
                actionButton("Pausieren") { client.run(.taskPause, args) }
            }
            if capabilities.contains(Capability.taskControl), task.status == .paused {
                actionButton("Fortsetzen") { client.run(.taskResume, args) }
            }
            if capabilities.contains(Capability.providerFallback), isLimit {
                actionButton("Provider-Fallback") { client.run(.taskFallback, args) }
            }
        }
    }

    private func actionButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .font(.caption)
    }
}
