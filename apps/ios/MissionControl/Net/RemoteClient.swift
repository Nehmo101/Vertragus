//
//  RemoteClient.swift
//  Mission Control
//
//  The single source of live state. Ports apps/mobile/src/App.tsx: bearer pairing,
//  a WebSocket live channel with SSE failover, requestId command correlation, and
//  the /devices, /speech/transcribe and /push/apns calls.
//

import Foundation
import Combine

enum RemoteError: LocalizedError {
    case server(String)
    case timeout
    case disconnected
    case invalidURL

    var errorDescription: String? {
        switch self {
        case .server(let message): return message
        case .timeout: return "Zeitüberschreitung beim Remote-Befehl."
        case .disconnected: return "Nicht mit dem Gateway verbunden."
        case .invalidURL: return "Ungültige Server-URL."
        }
    }
}

@MainActor
final class RemoteClient: ObservableObject {
    @Published private(set) var isPaired: Bool
    @Published private(set) var connected = false
    @Published private(set) var snapshots: [String: OrchestratorSnapshot] = [:]
    @Published private(set) var approvals: [ApprovalItem] = []
    @Published private(set) var devices: [DeviceInfo] = []
    @Published private(set) var currentDevice: DeviceInfo?
    @Published var errorMessage: String?

    private let store: SecureStore
    private let urlSession: URLSession
    private var token: String?
    private var endpoints: Endpoints?
    private var channelTask: Task<Void, Never>?
    private var webSocketTask: URLSessionWebSocketTask?
    private var reconnectAttempt = 0
    private var commandWaiters: [String: CheckedContinuation<CommandResultPayload?, Error>] = [:]

    init(store: SecureStore = SecureStore()) {
        self.store = store
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 30
        self.urlSession = URLSession(configuration: configuration)
        self.token = store.readToken()
        self.currentDevice = store.readDevice()
        self.isPaired = store.readToken() != nil
        if let base = store.baseURLString { self.endpoints = Endpoints(baseURLString: base) }
    }

    var lastBaseURLString: String { store.baseURLString ?? "" }

    /// Live-connect once the UI is on screen (called from RootView.task).
    func bootstrap() {
        guard token != nil else { return }
        start()
        Task { await loadDevices() }
    }

    // MARK: - Derived state (mirrors App.tsx profiles / goalProfiles)

    var orderedSnapshots: [OrchestratorSnapshot] {
        snapshots.values.sorted { ($0.sessionKey ?? "") < ($1.sessionKey ?? "") }
    }

    var profiles: [String] {
        var ids = Set<String>()
        for snapshot in snapshots.values { if let id = snapshot.profileId { ids.insert(id) } }
        for scope in currentDevice?.scopes ?? [] { ids.insert(scope.profileId) }
        return ids.sorted()
    }

    var goalProfiles: [String] {
        guard let device = currentDevice else { return [] }
        return profiles.filter { profile in
            device.scopes.contains { $0.profileId == profile && $0.allowGoalSubmit }
        }
    }

    func capabilities() -> [String] { currentDevice?.capabilities ?? [] }

    // MARK: - Pairing

    func pair(baseURLString: String, code: String, deviceName: String) async {
        errorMessage = nil
        guard let endpoints = Endpoints(baseURLString: baseURLString) else {
            errorMessage = RemoteError.invalidURL.localizedDescription
            return
        }
        do {
            var request = URLRequest(url: endpoints.pair)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(["code": code, "deviceName": deviceName])
            let (data, response) = try await urlSession.data(for: request)
            try Self.ensureOK(response, data)
            let result = try JSONDecoder().decode(PairingResult.self, from: data)
            store.baseURLString = endpoints.base.absoluteString
            store.saveToken(result.token)
            store.saveDevice(result.device)
            self.endpoints = endpoints
            self.token = result.token
            self.currentDevice = result.device
            self.isPaired = true
            start()
            Task { await loadDevices() }
        } catch {
            errorMessage = Self.message(from: error)
        }
    }

    func unpair() {
        stop()
        store.clear()
        token = nil
        isPaired = false
        snapshots = [:]
        approvals = []
        devices = []
        currentDevice = nil
    }

    // MARK: - Commands

    @discardableResult
    func command<Args: Encodable>(_ id: RemoteCommandId, _ args: Args) async throws -> CommandResultPayload? {
        errorMessage = nil
        guard let token, let endpoints else { throw RemoteError.disconnected }
        let requestId = UUID().uuidString
        let envelope = CommandEnvelope(id: id.rawValue, args: args, requestId: requestId)
        let payload = try JSONEncoder().encode(envelope)

        if let socket = webSocketTask, connected {
            return try await withCheckedThrowingContinuation { continuation in
                commandWaiters[requestId] = continuation
                socket.send(.string(String(decoding: payload, as: UTF8.self))) { [weak self] error in
                    guard let error else { return }
                    Task { @MainActor in self?.failWaiter(requestId, error) }
                }
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 15_000_000_000)
                    self?.failWaiter(requestId, RemoteError.timeout)
                }
            }
        }

        var request = URLRequest(url: endpoints.command)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = payload
        let (data, response) = try await urlSession.data(for: request)
        try Self.ensureOK(response, data)
        return try JSONDecoder().decode(CommandResponse.self, from: data).result
    }

    /// Convenience wrapper that surfaces errors on `errorMessage` instead of throwing.
    func run<Args: Encodable>(_ id: RemoteCommandId, _ args: Args) {
        Task {
            do { _ = try await command(id, args) }
            catch { errorMessage = Self.message(from: error) }
        }
    }

    // MARK: - Devices, speech, push

    func loadDevices() async {
        guard let token, let endpoints else { return }
        do {
            var request = URLRequest(url: endpoints.devices)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let (data, response) = try await urlSession.data(for: request)
            try Self.ensureOK(response, data)
            let decoded = try JSONDecoder().decode(DevicesResponse.self, from: data)
            devices = decoded.devices
            if let saved = store.readDevice(), let match = decoded.devices.first(where: { $0.id == saved.id }) {
                currentDevice = match
            }
        } catch {
            errorMessage = Self.message(from: error)
        }
    }

    func transcribe(mimeType: String, durationMs: Int, audioBase64: String) async throws -> String {
        guard let token, let endpoints else { throw RemoteError.disconnected }
        var request = URLRequest(url: endpoints.speech)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(
            SpeechRequest(mimeType: mimeType, durationMs: durationMs, audioBase64: audioBase64)
        )
        let (data, response) = try await urlSession.data(for: request)
        try Self.ensureOK(response, data)
        let decoded = try JSONDecoder().decode(SpeechResponse.self, from: data)
        guard decoded.ok, let text = decoded.text, !text.isEmpty else {
            throw RemoteError.server(decoded.message ?? "Transkription fehlgeschlagen.")
        }
        return text
    }

    /// Registers the native APNs device token with the desktop gateway. `token` is
    /// the hex string from `didRegisterForRemoteNotificationsWithDeviceToken`.
    func registerApns(deviceToken hex: String) async {
        guard let bearer = token, let endpoints else { return }
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        let bundleId = Bundle.main.bundleIdentifier ?? "com.vertragus.missioncontrol"
        do {
            var request = URLRequest(url: endpoints.apns)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
            request.httpBody = try JSONEncoder().encode(
                ApnsRegisterRequest(token: hex, environment: environment, bundleId: bundleId)
            )
            let (data, response) = try await urlSession.data(for: request)
            try Self.ensureOK(response, data)
        } catch {
            errorMessage = Self.message(from: error)
        }
    }

    // MARK: - Live channel

    private func start() {
        guard token != nil else { return }
        channelTask?.cancel()
        channelTask = Task { await runChannel() }
    }

    private func stop() {
        channelTask?.cancel()
        channelTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        connected = false
        failAllWaiters(RemoteError.disconnected)
    }

    private func runChannel() async {
        var websocketFailures = 0
        while !Task.isCancelled, token != nil, let endpoints {
            if websocketFailures < 2, let wsURL = endpoints.webSocket, let token {
                let opened = await runWebSocket(token: token, url: wsURL)
                websocketFailures = opened ? 0 : websocketFailures + 1
            } else if let token {
                _ = await runSSE(token: token, endpoints: endpoints)
            }
            if Task.isCancelled { break }
            connected = false
            reconnectAttempt += 1
            let delay = min(30.0, pow(2.0, Double(min(reconnectAttempt, 5))))
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            catch { break }
        }
    }

    private func runWebSocket(token: String, url: URL) async -> Bool {
        let socket = urlSession.webSocketTask(with: url, protocols: ["vertragus-v1", "orca-v1", "vertragus-bearer.\(token)", "orca-bearer.\(token)"])
        webSocketTask = socket
        socket.resume()
        var opened = false
        do {
            while !Task.isCancelled {
                let message = try await socket.receive()
                if !opened { opened = true; connected = true; reconnectAttempt = 0 }
                switch message {
                case .string(let text): route(Data(text.utf8))
                case .data(let data): route(data)
                @unknown default: break
                }
            }
        } catch {
            // Channel closed or failed to open; caller decides on failover/backoff.
        }
        if webSocketTask === socket { webSocketTask = nil }
        socket.cancel(with: .goingAway, reason: nil)
        connected = false
        failAllWaiters(RemoteError.disconnected)
        return opened
    }

    private func runSSE(token: String, endpoints: Endpoints) async -> Bool {
        var request = URLRequest(url: endpoints.stream)
        request.timeoutInterval = 3600
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        do {
            let (bytes, response) = try await urlSession.bytes(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return false
            }
            connected = true
            reconnectAttempt = 0
            var dataLines: [String] = []
            for try await line in bytes.lines {
                if Task.isCancelled { break }
                if line.isEmpty {
                    if !dataLines.isEmpty {
                        route(Data(dataLines.joined(separator: "\n").utf8))
                        dataLines.removeAll()
                    }
                } else if line.hasPrefix("data:") {
                    dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                }
            }
            return true
        } catch {
            return false
        }
    }

    private func route(_ data: Data) {
        guard let message = try? JSONDecoder().decode(IncomingMessage.self, from: data) else { return }
        switch message {
        case .snapshot(let snapshot):
            if let key = snapshot.sessionKey { snapshots[key] = snapshot }
        case .approvals(let items):
            approvals = items
        case .commandResult(let requestId, let ok, let result, let error):
            guard let requestId else { return }
            if ok { resolveWaiter(requestId, result) }
            else { failWaiter(requestId, RemoteError.server(error ?? "Remote-Befehl fehlgeschlagen.")) }
        case .event, .ping, .unknown:
            break
        }
    }

    // MARK: - Command waiters

    private func resolveWaiter(_ id: String, _ payload: CommandResultPayload?) {
        commandWaiters.removeValue(forKey: id)?.resume(returning: payload)
    }

    private func failWaiter(_ id: String, _ error: Error) {
        commandWaiters.removeValue(forKey: id)?.resume(throwing: error)
    }

    private func failAllWaiters(_ error: Error) {
        let waiters = commandWaiters
        commandWaiters.removeAll()
        for continuation in waiters.values { continuation.resume(throwing: error) }
    }

    // MARK: - Helpers

    static func message(from error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    static func ensureOK(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw RemoteError.server("Keine HTTP-Antwort.") }
        guard (200..<300).contains(http.statusCode) else {
            throw RemoteError.server(errorMessage(from: data) ?? "HTTP \(http.statusCode)")
        }
    }

    private static func errorMessage(from data: Data) -> String? {
        struct Body: Decodable { let error: String? }
        return (try? JSONDecoder().decode(Body.self, from: data))?.error
    }
}

// MARK: - Wire response shapes

private struct DevicesResponse: Decodable { let devices: [DeviceInfo] }
private struct CommandResponse: Decodable { let ok: Bool?; let result: CommandResultPayload? }
private struct SpeechRequest: Encodable { let mimeType: String; let durationMs: Int; let audioBase64: String }
private struct SpeechResponse: Decodable { let ok: Bool; let text: String?; let message: String? }
struct ApnsRegisterRequest: Encodable { let token: String; let environment: String; let bundleId: String }
