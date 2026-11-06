import Foundation

/// A push notice exactly as the host writes it (`parsePushNotice` in packages/protocol/src/push.ts): an id, a kind and
/// the host. It carries no title, command or terminal, so the app shows a fixed text per kind.
struct Notice {
    let id: String
    let kind: String
    let host: String

    private static let shape = try! NSRegularExpression(
        pattern: #"^\{"v":1,"n":"([A-Za-z0-9_-]{22})","k":"(input|permission|done|error|test)","h":"([a-z2-7]{26})"\}\z"#
    )

    /// Nil for anything but the host's exact notice.
    static func parse(_ json: String) -> Notice? {
        let range = NSRange(json.startIndex..., in: json)
        guard let match = shape.firstMatch(in: json, range: range), match.numberOfRanges == 4 else { return nil }
        func group(_ i: Int) -> String { String(json[Range(match.range(at: i), in: json)!]) }
        return Notice(id: group(1), kind: group(2), host: group(3))
    }

    /// The same texts as the web app's service worker (apps/web/src/push/notice-display.ts).
    var body: String {
        switch kind {
        case "input": return "An agent is waiting for your input."
        case "permission": return "An agent is asking for permission."
        case "done": return "An agent finished its turn."
        case "error": return "An agent stopped with an error."
        default: return "Notifications from this host work."
        }
    }

    /// The app's address for this notice, as the service worker opens it; `answer` is nil, allow or deny.
    func url(answer: String? = nil) -> String {
        "/?notice=\(id)&host=\(host)" + (answer.map { "&answer=\($0)" } ?? "")
    }
}
