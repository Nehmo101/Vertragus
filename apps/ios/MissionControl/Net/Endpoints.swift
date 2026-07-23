//
//  Endpoints.swift
//  Mission Control
//
//  Builds gateway URLs from a configurable base (the Cloudflare tunnel origin).
//  Unlike the PWA — which is served by the gateway and uses same-origin relative
//  paths — a native client must point at the tunnel origin explicitly.
//

import Foundation

struct Endpoints {
    let base: URL

    /// Normalizes user/QR input to a bare origin (scheme + host + optional port),
    /// defaulting to https when no scheme is given. Drops any path/query/fragment.
    init?(baseURLString: String) {
        let trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        var comps = URLComponents(string: trimmed)
        if comps?.scheme == nil { comps = URLComponents(string: "https://" + trimmed) }
        guard
            let scheme = comps?.scheme?.lowercased(), scheme == "https" || scheme == "http",
            let host = comps?.host, !host.isEmpty
        else { return nil }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = comps?.port
        guard let url = origin.url else { return nil }
        self.base = url
    }

    init(base: URL) { self.base = base }

    private func url(_ path: String) -> URL {
        var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        comps.path = path
        return comps.url!
    }

    var pair: URL { url("/pair") }
    var stream: URL { url("/stream") }
    var command: URL { url("/command") }
    var devices: URL { url("/devices") }
    var speech: URL { url("/speech/transcribe") }
    var apns: URL { url("/push/apns") }

    var webSocket: URL? {
        var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        comps.scheme = base.scheme == "https" ? "wss" : "ws"
        comps.path = "/ws"
        return comps.url
    }
}

/// Parses the desktop pairing QR payload `${publicUrl}/#/pair?code=XYZ`, yielding
/// both the tunnel origin (base URL) and the one-time pairing code in one scan.
struct PairingLink {
    let baseURLString: String
    let code: String?

    init?(scanned: String) {
        let trimmed = scanned.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            let comps = URLComponents(string: trimmed),
            let scheme = comps.scheme, scheme.hasPrefix("http"),
            let host = comps.host, !host.isEmpty
        else { return nil }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = comps.port
        self.baseURLString = origin.url?.absoluteString ?? trimmed
        self.code = PairingLink.extractCode(from: comps)
    }

    static func extractCode(from comps: URLComponents) -> String? {
        if let value = comps.queryItems?.first(where: { $0.name == "code" })?.value, !value.isEmpty {
            return value
        }
        // The code usually lives in the hash route, e.g. fragment "/pair?code=XYZ".
        if let fragment = comps.fragment, let range = fragment.range(of: "code=") {
            let code = fragment[range.upperBound...].prefix { $0 != "&" }
            return code.isEmpty ? nil : String(code)
        }
        return nil
    }
}
