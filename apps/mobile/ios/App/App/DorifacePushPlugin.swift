import Capacitor
import UIKit
import UserNotifications

extension Notification.Name {
    static let dorifaceNoticeTap = Notification.Name("dorifaceNoticeTap")
}

/// `DorifacePush`: the web app's push registrar in the iOS app (apps/web/src/native/shell.ts).
@objc(DorifacePushPlugin)
public class DorifacePushPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DorifacePushPlugin"
    public let jsName = "DorifacePush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "current", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unregister", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeLaunchTap", returnType: CAPPluginReturnPromise),
    ]

    /// A tap that arrived before the page listened; handed over once by `takeLaunchTap`.
    static var launchURL: String?
    private var pendingRegister: CAPPluginCall?
    private var pendingCalls: [CAPPluginCall] = []
    private static let tokenKey = "dev.omo.doriface.push.token"

    private var sandbox: Bool {
        #if DEBUG
            return true
        #else
            return false
        #endif
    }

    override public func load() {
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(tapped(_:)), name: .dorifaceNoticeTap, object: nil)
        center.addObserver(self, selector: #selector(registered(_:)), name: .capacitorDidRegisterForRemoteNotifications, object: nil)
        center.addObserver(self, selector: #selector(failed(_:)), name: .capacitorDidFailToRegisterForRemoteNotifications, object: nil)
    }

    @objc private func tapped(_ note: Notification) {
        guard let url = note.object as? String else { return }
        if hasListeners("noticeTap") { notifyListeners("noticeTap", data: ["url": url]) } else { Self.launchURL = url }
    }

    private func permission(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        default: return "default"
        }
    }

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            call.resolve(["receive": self.permission(settings.authorizationStatus)])
        }
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            self.checkPermissions(call)
        }
    }

    private func registration(_ token: String) throws -> [String: Any] {
        guard let keys = try NoticeKeys.load(create: true) else { throw NSError(domain: "doriface", code: 1) }
        return ["platform": "ios", "token": token, "sandbox": sandbox, "p256dh": keys.p256dh.base64url, "auth": keys.auth.base64url]
    }

    @objc func register(_ call: CAPPluginCall) {
        // The waiting calls are read and written on the main queue only, where `registered` and `failed` run (AppDelegate
        // posts them there). Capacitor calls this on the plugin's own queue: a call appended there as the token arrives
        // could land after the list was taken and never settle (#871).
        DispatchQueue.main.async {
            // One registration at a time: a call while one waits gets the same answer instead of leaving the first unsettled.
            if self.pendingRegister != nil {
                self.pendingCalls.append(call)
                return
            }
            self.pendingRegister = call
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    @objc private func registered(_ note: Notification) {
        guard let call = pendingRegister, let token = note.object as? Data else { return }
        let calls = [call] + pendingCalls
        pendingRegister = nil
        pendingCalls = []
        let hex = token.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(hex, forKey: Self.tokenKey)
        do {
            let answer = try registration(hex)
            calls.forEach { $0.resolve(answer) }
        } catch {
            calls.forEach { $0.reject("The notification keys could not be made", "keys", error) }
        }
    }

    @objc private func failed(_ note: Notification) {
        guard let call = pendingRegister else { return }
        let calls = [call] + pendingCalls
        pendingRegister = nil
        pendingCalls = []
        let reason = (note.object as? Error)?.localizedDescription ?? "unknown"
        calls.forEach { $0.reject("APNs gave no token: \(reason)", "no-token") }
    }

    @objc func current(_ call: CAPPluginCall) {
        guard let token = UserDefaults.standard.string(forKey: Self.tokenKey) else { return call.resolve(["registration": NSNull()]) }
        do { call.resolve(["registration": try registration(token)]) } catch { call.reject("The notification keys could not be read", "keys", error) }
    }

    @objc func unregister(_ call: CAPPluginCall) {
        UserDefaults.standard.removeObject(forKey: Self.tokenKey)
        DispatchQueue.main.async { UIApplication.shared.unregisterForRemoteNotifications() }
        call.resolve()
    }

    @objc func takeLaunchTap(_ call: CAPPluginCall) {
        let url = Self.launchURL
        Self.launchURL = nil
        call.resolve(["tap": url.map { ["url": $0] } ?? NSNull()])
    }
}
