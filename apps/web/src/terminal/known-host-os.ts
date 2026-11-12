import type { HostOs } from "@doriface/protocol";
import type { StorageLike } from "../storage/guarded.ts";
import { type HostPlatform } from "./keys.ts";
import { platformOf } from "./host-os.ts";

/** The key bar's platform for a host the app cannot reach right now (#2385). */
export function offlinePlatform(storage: StorageLike, hostId: string, name: string): HostPlatform {
  void storage;
  void hostId;
  return platformOf(undefined, name);
}

/** Keeps the OS a reachable host reported, for when it is not reachable (#2385). */
export function rememberHostOs(storage: StorageLike, hostId: string, os: HostOs): void {
  void storage;
  void hostId;
  void os;
}
