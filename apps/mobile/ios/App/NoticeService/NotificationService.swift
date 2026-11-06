import UserNotifications

/// Opens each notice the push bridge forwards through APNs (#705) with the app's keys, before iOS shows it: the alert
/// APNs carries is a fixed text, and the real kind exists only inside the host's ciphertext (`p`).
final class NotificationService: UNNotificationServiceExtension {
    private var deliver: ((UNNotificationContent) -> Void)?
    private var fallback: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler handler: @escaping (UNNotificationContent) -> Void) {
        deliver = handler
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        fallback = content
        guard
            let payload = request.content.userInfo["p"] as? String,
            let body = Data(base64url: payload),
            let keys = try? NoticeKeys.load(create: false),
            let plain = try? keys.open(body),
            let notice = Notice.parse(String(decoding: plain, as: UTF8.self))
        else {
            finish(content)
            return
        }
        content.title = "doriface"
        content.body = notice.body
        content.threadIdentifier = notice.host
        content.userInfo = ["doriface-url": notice.url(), "doriface-id": notice.id, "doriface-host": notice.host]
        if notice.kind == "permission" { content.categoryIdentifier = NoticeCategory.permission }
        finish(content)
    }

    /// Hands iOS one content, once: a later expiry callback finds nothing left to deliver.
    private func finish(_ content: UNNotificationContent) {
        let handler = deliver
        deliver = nil
        fallback = nil
        handler?(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let fallback { finish(fallback) }
    }
}
