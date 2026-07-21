//
//  PushRegistrar.swift
//  Mission Control
//
//  Owns notification authorization and routes a tapped notification's deep link
//  (transition.url from the desktop, e.g. "/#/approvals") back into the tab UI.
//

import Foundation
import UserNotifications
import UIKit

final class PushRegistrar: NSObject, ObservableObject {
    static let shared = PushRegistrar()

    /// Deep-link route requested by a tapped notification (e.g. "/#/approvals").
    @Published var requestedRoute: String?
    @Published var authorizationError: String?
    /// Retained so re-pairing can re-register the same device token.
    var lastDeviceTokenHex: String?

    func configure() {
        UNUserNotificationCenter.current().delegate = self
    }

    /// Requests permission and, if granted, asks the system for an APNs token.
    func requestAndRegister() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            DispatchQueue.main.async {
                if let error {
                    self.authorizationError = error.localizedDescription
                    return
                }
                guard granted else {
                    self.authorizationError = "Benachrichtigungen wurden nicht erlaubt."
                    return
                }
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }
}

extension PushRegistrar: UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let route = response.notification.request.content.userInfo["url"] as? String
        DispatchQueue.main.async {
            if let route { self.requestedRoute = route }
            completionHandler()
        }
    }
}
