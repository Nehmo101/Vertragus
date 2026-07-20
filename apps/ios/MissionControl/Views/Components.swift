//
//  Components.swift
//  Mission Control
//

import SwiftUI

struct ConnectionBadge: View {
    let connected: Bool
    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(connected ? Color.green : Color.orange)
                .frame(width: 8, height: 8)
            Text(connected ? "Live" : "Verbinde…")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

struct Eyebrow: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.caption2.weight(.semibold))
            .tracking(1.5)
            .foregroundStyle(Theme.bronzeDim)
    }
}

struct Pill: View {
    let text: String
    var color: Color = .secondary
    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}

struct EmptyStateView: View {
    let title: String
    let message: String
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "circle.dotted")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

private struct ErrorBannerModifier: ViewModifier {
    @ObservedObject var client: RemoteClient
    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .top, spacing: 0) {
            if let message = client.errorMessage {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                    Text(message).font(.footnote)
                    Spacer(minLength: 8)
                    Button { client.errorMessage = nil } label: {
                        Image(systemName: "xmark").font(.caption.weight(.bold))
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.92))
                .foregroundStyle(.white)
            }
        }
    }
}

extension View {
    func errorBanner(_ client: RemoteClient) -> some View {
        modifier(ErrorBannerModifier(client: client))
    }
}
