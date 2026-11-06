import CryptoKit
import Foundation
import Security

/// The app's push subscription keys (RFC 8291): a P-256 key pair and a 16-byte auth secret, made once. They stay on
/// the device in the Keychain, in an access group the Notification Service Extension shares, readable after the first
/// unlock so a notice can be opened while the phone is locked.
struct NoticeKeys {
    let privateKey: P256.KeyAgreement.PrivateKey
    let auth: Data

    var p256dh: Data { privateKey.publicKey.x963Representation }

    private static let service = "dev.omo.doriface.push"
    private static var accessGroup: String? { Bundle.main.object(forInfoDictionaryKey: "DorifaceKeychainGroup") as? String }

    private static func query(_ account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let group = accessGroup { query[kSecAttrAccessGroup as String] = group }
        return query
    }

    private static func read(_ account: String) -> Data? {
        var q = query(account)
        q[kSecReturnData as String] = true
        var out: AnyObject?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    private static func write(_ account: String, _ value: Data) throws {
        var q = query(account)
        SecItemDelete(q as CFDictionary)
        q[kSecValueData as String] = value
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    /// The stored keys; `create` makes and stores them on first use (the app does, the extension only reads).
    static func load(create: Bool) throws -> NoticeKeys? {
        if let raw = read("key"), let auth = read("auth") {
            return NoticeKeys(privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: raw), auth: auth)
        }
        guard create else { return nil }
        let key = P256.KeyAgreement.PrivateKey()
        var auth = Data(count: 16)
        let status = auth.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        try write("key", key.rawRepresentation)
        try write("auth", auth)
        return NoticeKeys(privateKey: key, auth: auth)
    }

    func open(_ body: Data) throws -> Data {
        try WebPushDecrypt.decrypt(body, privateKey: privateKey, auth: auth)
    }
}

extension Data {
    init?(base64url text: String) {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }

    var base64url: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
