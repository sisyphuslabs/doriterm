import type { HcConnection } from "@doriface/client";
import type { ConnectionSettings } from "./settings.ts";

/**
 * The name a host gave itself in its hello, or `""` when it gave none: Settings names a host by this while it answers, and a
 * session must never fail over a name it could not read (#496).
 */
export function helloName(connection: HcConnection): string {
  const hello: { readonly core?: { readonly name?: string } } | undefined = connection.hello;
  return hello?.core?.name ?? "";
}

/**
 * The name the workspace shows for the machine whose core this client is attached to (#1902). A browser that joined a
 * mesh names every machine by its mesh member name, the one Settings > Machines and every other machine's row use, so
 * the machine it happens to be attached through is named the same way: hc's own name for itself is its OS hostname,
 * which would give that one machine a second name, and a different machine that name after it re-attaches elsewhere.
 * `shownHostId` is the member whose connection the workspace shows: its mesh name is `settings.hostName` when it is the
 * attached member (a joined browser holds that one there, not in `members`), else its row in `members`. Anywhere else (a paired host, which is no member,
 * or a member the roster does not hold or has not named yet) the name the core answered with is the only one there is.
 */
export function attachedMachineName(
  connection: HcConnection,
  settings: Pick<ConnectionSettings, "viewMember" | "members" | "hostId" | "hostName">,
  shownHostId: string | undefined,
): string {
  if (settings.viewMember === true && shownHostId !== undefined) {
    // A joined browser keeps the member it is attached to as its own hostId and mesh hostName, and any others in members.
    const name =
      settings.hostId === shownHostId
        ? settings.hostName
        : (settings.members.find((member) => member.hostId === shownHostId)?.hostName ?? "");
    if (name !== "") return name;
  }
  return helloName(connection);
}
