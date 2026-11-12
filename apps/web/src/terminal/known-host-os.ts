import type { HostOs } from "@doriface/protocol";
import type { ConnectionSettings } from "../connection/settings.ts";
import type { StorageLike } from "../storage/guarded.ts";
import { type HostPlatform, platformOf } from "./keys.ts";

const KEY = "doriface.hostOs";
const OS: ReadonlySet<string> = new Set<HostOs>(["darwin", "linux", "win32"]);

function remembered(storage: StorageLike): Readonly<Record<string, HostOs>> {
  try {
    const raw: unknown = JSON.parse(storage.getItem(KEY) ?? "{}");
    if (typeof raw !== "object" || raw === null) return {};
    return Object.fromEntries(
      Object.entries(raw).filter(
        (entry): entry is [string, HostOs] => typeof entry[1] === "string" && OS.has(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

/**
 * The key bar's platform for a host the app cannot reach right now (#2385). What the host itself reported the last
 * time it was reachable comes first: a name is only a guess, and a mesh member's name (`m942-a`) says nothing about
 * the machine. The guess from the name is left for a host this app has never reached.
 */
export function offlinePlatform(storage: StorageLike, hostId: string, name: string): HostPlatform {
  return platformOf(remembered(storage)[hostId], name);
}

/** Keeps the OS a reachable host reported, by its id, for when it is not reachable (#2385). */
export function rememberHostOs(storage: StorageLike, hostId: string, os: HostOs): void {
  const known = remembered(storage);
  if (known[hostId] === os) return;
  storage.setItem(KEY, JSON.stringify({ ...known, [hostId]: os }));
}

/**
 * The host id a remembered OS is kept under: the paired host's, and only over the relay. In loopback mode the line goes
 * to this computer's own host, so a hostId left from relay mode would file that host's OS under another host's id.
 */
export const rememberedHostId = (settings: Pick<ConnectionSettings, "mode" | "hostId">): string | undefined =>
  settings.mode === "relay" && settings.hostId !== "" ? settings.hostId : undefined;
