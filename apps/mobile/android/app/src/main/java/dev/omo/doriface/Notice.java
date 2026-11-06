package dev.omo.doriface;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A push notice exactly as the host writes it ({@code parsePushNotice} in {@code packages/protocol/src/push.ts}): an
 * id, a kind and the host. It carries no title, command or terminal, so the app shows a fixed text per kind.
 */
public final class Notice {
    private static final Pattern SHAPE = Pattern.compile(
        "^\\{\"v\":1,\"n\":\"([A-Za-z0-9_-]{22})\",\"k\":\"(input|permission|done|error|test)\",\"h\":\"([a-z2-7]{26})\"\\}$"
    );

    public final String id;
    public final String kind;
    public final String host;

    private Notice(String id, String kind, String host) {
        this.id = id;
        this.kind = kind;
        this.host = host;
    }

    /** Null for anything but the host's exact notice. */
    public static Notice parse(String json) {
        Matcher match = SHAPE.matcher(json);
        return match.matches() ? new Notice(match.group(1), match.group(2), match.group(3)) : null;
    }

    /** The same texts as the web app's service worker ({@code apps/web/src/push/notice-display.ts}). */
    public String body() {
        switch (kind) {
            case "input":
                return "An agent is waiting for your input.";
            case "permission":
                return "An agent is asking for permission.";
            case "done":
                return "An agent finished its turn.";
            case "error":
                return "An agent stopped with an error.";
            default:
                return "Notifications from this host work.";
        }
    }

    /** The app's address for this notice, as the service worker opens it; {@code answer} is null, allow or deny. */
    public String url(String answer) {
        return "/?notice=" + id + "&host=" + host + (answer == null ? "" : "&answer=" + answer);
    }
}
