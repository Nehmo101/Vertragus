//
//  AppDelegate.swift
//  Mission Control
//
//  Bridges UIKit's APNs registration callbacks into the SwiftUI world.
//

import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    /// Called with the hex-encoded APNs device token once registration succeeds.
    var onDeviceToken: ((String) -> Void)?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        PushRegistrar.shared.configure()
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        onDeviceToken?(hex)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        DispatchQueue.main.async {
            PushRegistrar.shared.authorizationError = error.localizedDescription
        }
    }
}
