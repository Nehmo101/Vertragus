//
//  GoalView.swift
//  Mission Control
//
//  Submit a new goal (always yoloMaster:false server-side) with optional native
//  voice dictation via /speech/transcribe. Parity with the PWA `Goal` view.
//

import SwiftUI
import AVFoundation

struct GoalView: View {
    @EnvironmentObject private var client: RemoteClient
    @StateObject private var recorder = AudioRecorder()
    @State private var profileId = ""
    @State private var goalText = ""
    @State private var sending = false

    private var canSend: Bool {
        !profileId.isEmpty && !goalText.trimmingCharacters(in: .whitespaces).isEmpty && !sending
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Remote-Ziele werden immer mit yoloMaster:false über den vorhandenen Idea-Transfer gestartet.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section("Workspace") {
                    if client.goalProfiles.isEmpty {
                        Text("Kein Workspace mit Ziel-Freigabe.").foregroundStyle(.secondary)
                    } else {
                        Picker("Workspace", selection: $profileId) {
                            ForEach(client.goalProfiles, id: \.self) { Text($0).tag($0) }
                        }
                    }
                }
                Section("Ziel") {
                    TextEditor(text: $goalText).frame(minHeight: 140)
                    if client.capabilities().contains(Capability.speech) {
                        Button(action: toggleSpeech) {
                            Label(
                                recorder.isRecording ? "Aufnahme stoppen" : "Ziel sprechen",
                                systemImage: recorder.isRecording ? "stop.circle.fill" : "mic"
                            )
                        }
                    }
                }
                Section {
                    Button(action: send) {
                        if sending {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text("Ziel sicher senden").frame(maxWidth: .infinity)
                        }
                    }
                    .disabled(!canSend)
                }
            }
            .navigationTitle("Ziel")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ConnectionBadge(connected: client.connected)
                }
            }
            .errorBanner(client)
            .onAppear { if profileId.isEmpty { profileId = client.goalProfiles.first ?? "" } }
            .onChange(of: client.goalProfiles) { profiles in
                if !profiles.contains(profileId) { profileId = profiles.first ?? "" }
            }
        }
    }

    private func send() {
        sending = true
        Task {
            do {
                _ = try await client.command(.goalSubmit, GoalArgs(profileId: profileId, text: goalText))
                goalText = ""
            } catch {
                client.errorMessage = RemoteClient.message(from: error)
            }
            sending = false
        }
    }

    private func toggleSpeech() {
        if recorder.isRecording {
            guard let result = recorder.stop() else { return }
            Task {
                do {
                    goalText = try await client.transcribe(
                        mimeType: "audio/mp4",
                        durationMs: result.durationMs,
                        audioBase64: result.data.base64EncodedString()
                    )
                } catch {
                    client.errorMessage = RemoteClient.message(from: error)
                }
            }
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async {
                    guard granted else {
                        client.errorMessage = "Mikrofon wurde nicht erlaubt."
                        return
                    }
                    do { try recorder.start() }
                    catch { client.errorMessage = RemoteClient.message(from: error) }
                }
            }
        }
    }
}

/// Records a short AAC clip for voice-goal dictation.
final class AudioRecorder: NSObject, ObservableObject {
    @Published var isRecording = false
    private var recorder: AVAudioRecorder?
    private var fileURL: URL?
    private var startedAt = Date()

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default)
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("goal-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
        ]
        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.record()
        self.recorder = recorder
        self.fileURL = url
        self.startedAt = Date()
        self.isRecording = true
        // Hard cap mirrors the PWA (2 minutes).
        DispatchQueue.main.asyncAfter(deadline: .now() + 120) { [weak self] in
            if self?.isRecording == true { _ = self?.stop() }
        }
    }

    @discardableResult
    func stop() -> (data: Data, durationMs: Int)? {
        guard let recorder, let url = fileURL else { return nil }
        recorder.stop()
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false)
        let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        let data = try? Data(contentsOf: url)
        try? FileManager.default.removeItem(at: url)
        self.recorder = nil
        self.fileURL = nil
        guard let data else { return nil }
        return (data, durationMs)
    }
}
