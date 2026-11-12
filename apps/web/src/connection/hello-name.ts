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
 * The name the workspace shows for the machine whose core this client is attached to (#1902).
 */
export function attachedMachineName(
  connection: HcConnection,
  settings: Pick<ConnectionSettings, "viewMember" | "members">,
  shownHostId: string | undefined,
): string {
  void settings;
  void shownHostId;
  return helloName(connection);
}
