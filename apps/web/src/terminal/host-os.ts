import type { HcConnection } from "@doriface/client";
import { HOST_INFO_DOC, type HostOs, parseHostInfo } from "@doriface/protocol";
import { useEffect, useState } from "react";
import { type HostPlatform, hostPlatform } from "./keys.ts";

/**
 * The key bar's platform for a terminal's host: what the host reported on its core when it did, else the guess from
 * the core's or machine's name (an older host writes no OS).
 */
export const platformOf = (os: HostOs | undefined, name: string): HostPlatform =>
  os === undefined ? hostPlatform(name) : os === "darwin" ? "mac" : "other";

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
): HostPlatform {
  const key = `${machine ?? ""}#${offline}#${connection === null ? "none" : "live"}`;
  const [read, setRead] = useState<{ readonly key: string; readonly os: HostOs | undefined } | undefined>(undefined);
  useEffect(() => {
    if (connection === null) return undefined;
    let live = true;
    void (async () => {
      const os = await readHostOs(connection, machine);
      if (live) setRead({ key, os });
    })();
    return () => {
      live = false;
    };
  }, [connection, machine, key]);
  return platformOf(read?.key === key ? read.os : undefined, machine ?? connection?.hello.core.name ?? "");
}
