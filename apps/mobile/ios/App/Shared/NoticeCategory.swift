import UserNotifications

/// The notification category a permission notice carries: Allow and Deny open the app, which answers once on screen.
enum NoticeCategory {
    static let permission = "doriface.permission"

    static func register() {
        let allow = UNNotificationAction(identifier: "allow", title: "Allow", options: [.foreground, .authenticationRequired])
        let deny = UNNotificationAction(identifier: "deny", title: "Deny", options: [.foreground])
        let category = UNNotificationCategory(identifier: permission, actions: [allow, deny], intentIdentifiers: [])
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }
}
