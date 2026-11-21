import type { HcConnection } from "@doriface/client";
import { HOST_INFO_DOC, type HostOs, parseHostInfo } from "@doriface/protocol";
import { useEffect, useState } from "react";
import { guardedLocalStorage } from "../storage/guarded.ts";
import { type HostPlatform, platformOf } from "./keys.ts";
import { offlinePlatform, rememberHostOs } from "./known-host-os.ts";

export { platformOf } from "./keys.ts";

/** The OS a machine's doriface-host wrote on its core (`on` it, or this core), or undefined when it wrote none or the read failed. */
export async function readHostOs(
  connection: Pick<HcConnection, "call">,
  machine: string | undefined,
): Promise<HostOs | undefined> {
  try {
    const doc = await connection.call(
      "doc.get",
      machine === undefined ? { name: HOST_INFO_DOC } : { name: HOST_INFO_DOC, on: machine },
    );
    return parseHostInfo(doc.value)?.os;
  } catch {
    // An offline machine or an older core: the name's guess stands.
    return undefined;
  }
}

/**
 * The platform of the host a terminal runs on, read again when its machine or its line changes. With no connection yet
 * (Settings open before the first dial) it names the account's host instead of guessing from this device. That matters:
 * an iPhone is not a Mac, so a preview keyed on this phone's OS would draw `cmd` for a Linux host.
 */
export function useHostPlatform(
  connection: HcConnection | null,
  machine: string | undefined,
  offline: boolean,
  /** The host's id, when the caller has one: its reported OS is kept under it and stands in while there is no line (#2385). */
  hostId?: string,
): HostPlatform {
  const key = `${machine ?? ""}#${offline}#${connection === null ? "none" : "live"}`;
  const [read, setRead] = useState<{ readonly key: string; readonly os: HostOs | undefined } | undefined>(undefined);
  useEffect(() => {
    if (connection === null) return undefined;
    let live = true;
    void (async () => {
      const os = await readHostOs(connection, machine);
      if (!live) return;
      if (os !== undefined && hostId !== undefined && hostId !== "") rememberHostOs(guardedLocalStorage(), hostId, os);
      setRead({ key, os });
    })();
    return () => {
      live = false;
    };
  }, [connection, machine, key, hostId]);
  const name = machine ?? connection?.hello.core.name ?? "";
  const os = read?.key === key ? read.os : undefined;
  // No OS from the host (no line, a line that has dropped, or a read still on its way): what it reported last time stands.
  if (os === undefined && hostId !== undefined && hostId !== "")
    return offlinePlatform(guardedLocalStorage(), hostId, name);
  return platformOf(os, name);
}
