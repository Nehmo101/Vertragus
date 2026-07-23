//
//  SecureStore.swift
//  Mission Control
//
//  The bearer token lives only in the Keychain and is never written to a URL.
//  Base URL and the paired device record live in UserDefaults (non-secret).
//

import Foundation
import Security

struct SecureStore {
    private let service = "com.vertragus.missioncontrol"
    private let tokenAccount = "deviceToken"
    private let baseURLKey = "vertragus.remote.baseURL"
    private let deviceKey = "vertragus.remote.device"
    private let defaults = UserDefaults.standard

    // MARK: Token (Keychain)

    func readToken() -> String? {
        var query: [String: Any] = baseTokenQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let token = String(data: data, encoding: .utf8) else {
            return nil
        }
        return token
    }

    func saveToken(_ token: String) {
        let data = Data(token.utf8)
        SecItemDelete(baseTokenQuery as CFDictionary)
        var attributes = baseTokenQuery
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(attributes as CFDictionary, nil)
    }

    func deleteToken() {
        SecItemDelete(baseTokenQuery as CFDictionary)
    }

    private var baseTokenQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount
        ]
    }

    // MARK: Base URL + device (UserDefaults)

    var baseURLString: String? {
        get { defaults.string(forKey: baseURLKey) }
        nonmutating set { defaults.set(newValue, forKey: baseURLKey) }
    }

    func saveDevice(_ device: DeviceInfo) {
        if let data = try? JSONEncoder().encode(device) {
            defaults.set(data, forKey: deviceKey)
        }
    }

    func readDevice() -> DeviceInfo? {
        guard let data = defaults.data(forKey: deviceKey) else { return nil }
        return try? JSONDecoder().decode(DeviceInfo.self, from: data)
    }

    func clear() {
        deleteToken()
        defaults.removeObject(forKey: deviceKey)
        // Base URL is intentionally retained so re-pairing pre-fills the last server.
    }
}
