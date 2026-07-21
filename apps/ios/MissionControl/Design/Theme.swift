//
//  Theme.swift
//  Mission Control
//
//  Brand tokens from docs/BRAND.md. "Verdigris pulses where work happens;
//  Bronze marks orchestrator/decisions."
//

import SwiftUI

enum Theme {
    static let bronze = Color(red: 0xCB / 255, green: 0xA3 / 255, blue: 0x5A / 255)
    static let bronzeDim = Color(red: 0x93 / 255, green: 0x6C / 255, blue: 0x2B / 255)
    static let verdigris = Color(red: 0x2F / 255, green: 0x7D / 255, blue: 0x6D / 255)
    static let verdigrisDeep = Color(red: 0x0C / 255, green: 0x29 / 255, blue: 0x25 / 255)
    static let graphite = Color(red: 0x20 / 255, green: 0x24 / 255, blue: 0x2B / 255)
    static let vellum = Color(red: 0xED / 255, green: 0xE8 / 255, blue: 0xDD / 255)

    static func statusColor(_ status: TaskStatus) -> Color {
        switch status {
        case .running, .queued: return verdigris
        case .waiting, .paused: return bronze
        case .success: return .green
        case .needsWork: return .orange
        case .error, .stopped: return .red
        case .unknown: return .secondary
        }
    }

    static func ciColor(_ status: RemoteCiStatus) -> Color {
        switch status {
        case .passed: return .green
        case .failed, .timedOut: return .red
        case .pending, .waiting: return bronze
        case .cancelled, .unavailable, .unknown: return .secondary
        }
    }
}
