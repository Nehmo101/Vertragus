//
//  Contracts.swift
//  Mission Control
//
//  Codable mirror of the node-free Mission Control contracts.
//  Ported from src/shared/remote.ts and src/shared/orchestrator.ts — keep in sync.
//  All JSON keys are camelCase and match the TypeScript field names 1:1, so the
//  synthesized Codable conformances need no CodingKeys. Unknown keys are ignored;
//  unknown enum values decode to `.unknown` so a newer desktop never breaks the app.
//

import Foundation

// MARK: - Capabilities & command ids

/// Mirrors REMOTE_CAPABILITIES. Kept as raw strings for forward compatibility.
enum Capability {
    static let read = "read"
    static let steer = "steer"
    static let admin = "admin"
    static let diff = "diff"
    static let push = "push"
    static let speech = "speech"
    static let approveTools = "approve-tools"
    static let budget = "budget"
    static let taskControl = "task-control"
    static let replan = "replan"
    static let providerFallback = "provider-fallback"
}

/// Mirrors REMOTE_COMMAND_IDS.
enum RemoteCommandId: String {
    case planApprove = "plan.approve"
    case planReject = "plan.reject"
    case modeEnableAuto = "mode.enableAuto"
    case runReset = "run.reset"
    case goalSubmit = "goal.submit"
    case publicationApprove = "publication.approve"
    case publicationReject = "publication.reject"
    case taskDiff = "task.diff"
    case permissionAllow = "permission.allow"
    case permissionDeny = "permission.deny"
    case budgetSetCaps = "budget.setCaps"
    case taskPause = "task.pause"
    case taskResume = "task.resume"
    case taskFallback = "task.fallback"
    case planReplan = "plan.replan"
    case killSwitchActivate = "killSwitch.activate"
}

// MARK: - Enums with forward-compatible decoding

enum TaskStatus: String, Codable {
    case queued, running, waiting, paused, success
    case needsWork = "needs-work"
    case error, stopped
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TaskStatus(rawValue: raw) ?? .unknown
    }
}

enum ApprovalKind: String, Codable {
    case planReview = "plan-review"
    case taskBlocked = "task-blocked"
    case prPublication = "pr-publication"
    case toolPermission = "tool-permission"
    case budgetExceeded = "budget-exceeded"
    case providerLimit = "provider-limit"
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ApprovalKind(rawValue: raw) ?? .unknown
    }
}

enum RemoteCiStatus: String, Codable {
    case waiting, pending, passed, failed, cancelled
    case timedOut = "timed-out"
    case unavailable
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RemoteCiStatus(rawValue: raw) ?? .unknown
    }
}

// MARK: - Orchestrator read model (subset the UI renders)

struct OrchestratorGoal: Codable, Hashable {
    let id: String?
    let title: String?
    let active: Bool?
}

struct RemoteBudgetCaps: Codable, Hashable {
    let maxTokens: Double?
    let maxCostUsd: Double?
}

struct RemoteBudgetSnapshot: Codable, Hashable {
    let tokens: Double
    let costUsd: Double
    let caps: RemoteBudgetCaps
    let exceeded: Bool
    let tasksReported: Int?
    let tasksTotal: Int?
    let tokenDataComplete: Bool?
    let costDataComplete: Bool?
    let exceededBy: [String]?
}

struct OrcaTask: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    let role: String?
    let agentName: String?
    let status: TaskStatus
    let progress: Double?
    let lastAction: String?
    let note: String?
    let judgeReason: String?
    let planId: String?
    let prUrl: String?
    let commit: String?
    let remoteCiStatus: RemoteCiStatus?
}

struct ExecutionPlanTask: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    let role: String?
}

struct ExecutionPlan: Codable, Hashable {
    let goal: String
    let maxParallel: Int
    let tasks: [ExecutionPlanTask]
}

struct PendingPlanReview: Codable, Hashable {
    let planId: String
    let plan: ExecutionPlan
}

struct IntegrationCenterItem: Codable, Hashable, Identifiable {
    var id: String { taskId }
    let taskId: String
    let title: String
    let status: String
    let commit: String?
    let remoteCiStatus: RemoteCiStatus?
}

struct IntegrationCenterSnapshot: Codable, Hashable {
    let status: String
    let items: [IntegrationCenterItem]
}

struct PermissionRequest: Codable, Hashable {
    let id: String
    let provider: String?
    let tool: String?
    let summary: String?
}

struct OrchestratorSnapshot: Codable, Hashable, Identifiable {
    var id: String { workspaceSessionId ?? profileId ?? "workspace" }
    let profileId: String?
    let workspaceSessionId: String?
    let goal: OrchestratorGoal?
    let tasks: [OrcaTask]
    let budget: RemoteBudgetSnapshot?
    let pendingPlan: PendingPlanReview?
    let pendingApprovals: [ApprovalItem]?
    let integration: IntegrationCenterSnapshot?

    /// Key used to index snapshots by workspace session (matches App.tsx handleFrame).
    var sessionKey: String? { workspaceSessionId ?? profileId }
}

// MARK: - Approvals

struct ApprovalItem: Codable, Hashable, Identifiable {
    let id: String
    let kind: ApprovalKind
    let profileId: String
    let workspaceSessionId: String
    let title: String
    let summary: String
    let createdAt: Double
    let task: OrcaTask?
    let permission: PermissionRequest?
    let actions: [String]
}

// MARK: - Devices & pairing

struct RemoteActor: Codable, Hashable {
    let id: String
    let displayName: String
}

struct RemoteScope: Codable, Hashable {
    let profileId: String
    let sessionIds: [String]
    let allowGoalSubmit: Bool
}

struct DeviceInfo: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let capabilities: [String]
    let actor: RemoteActor
    let scopes: [RemoteScope]
    let createdAt: Double?
    let lastSeenAt: Double?
    let revokedAt: Double?

    var isRevoked: Bool { revokedAt != nil }
    func has(_ capability: String) -> Bool { capabilities.contains(capability) }
}

struct PairingResult: Codable {
    let token: String
    let device: DeviceInfo
}

// MARK: - Live frames (WS + SSE) and command results

/// The `result` object of a command-result / POST /command response. Only `diff`
/// is consumed by the UI (task.diff); every other command result is a resolve-only ack.
struct CommandResultPayload: Decodable {
    let diff: String?
}

/// One decoded message from the live channel. WS carries RemoteEventFrame plus the
/// `command-result` shape; SSE carries only the frame variants.
enum IncomingMessage: Decodable {
    case snapshot(OrchestratorSnapshot)
    case approvals([ApprovalItem])
    case event(kind: String, message: String)
    case ping
    case commandResult(requestId: String?, ok: Bool, result: CommandResultPayload?, error: String?)
    case unknown

    private enum CodingKeys: String, CodingKey {
        case type, snapshot, approvals, event, requestId, ok, result, error
    }
    private struct EventBody: Decodable { let kind: String?; let message: String? }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch (try? container.decode(String.self, forKey: .type)) ?? "" {
        case "snapshot":
            self = .snapshot(try container.decode(OrchestratorSnapshot.self, forKey: .snapshot))
        case "approvals":
            self = .approvals((try? container.decode([ApprovalItem].self, forKey: .approvals)) ?? [])
        case "event":
            let body = try? container.decode(EventBody.self, forKey: .event)
            self = .event(kind: body?.kind ?? "", message: body?.message ?? "")
        case "ping":
            self = .ping
        case "command-result":
            self = .commandResult(
                requestId: try? container.decode(String.self, forKey: .requestId),
                ok: (try? container.decode(Bool.self, forKey: .ok)) ?? false,
                result: try? container.decode(CommandResultPayload.self, forKey: .result),
                error: try? container.decode(String.self, forKey: .error)
            )
        default:
            self = .unknown
        }
    }
}

// MARK: - Command envelope + argument shapes (match src/main/remote/commands.ts zod schemas)

struct CommandEnvelope<Args: Encodable>: Encodable {
    let id: String
    let args: Args
    let requestId: String?
}

struct ScopeArgs: Encodable { let profileId: String; let sessionId: String }
struct GoalArgs: Encodable { let profileId: String; let text: String }
struct PublicationArgs: Encodable { let profileId: String; let sessionId: String; let planId: String? }
struct TaskArgs: Encodable { let profileId: String; let sessionId: String; let taskId: String }
struct PermissionArgs: Encodable { let profileId: String; let sessionId: String; let permissionId: String }
struct BudgetArgs: Encodable { let profileId: String; let sessionId: String; let maxTokens: Int?; let maxCostUsd: Double? }
struct ReplanArgs: Encodable { let profileId: String; let sessionId: String; let removeTaskIds: [String]; let maxParallel: Int? }
struct EmptyArgs: Encodable {}
