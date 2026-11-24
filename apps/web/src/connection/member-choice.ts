import type { ConnectionSettings } from "./settings.ts";

/**
 * The settings bound to the next member of the roster, or undefined when there is none to move to.
 *
 * With one member there is nothing to move to, so a single-host app behaves exactly as it did. A selected host that is not
 * in the roster cannot be moved on from: the roster rule puts it there, so its absence means the two disagree, and picking
 * members[0] would bind the app to a host nobody selected.
 */
export function nextMember(settings: ConnectionSettings): ConnectionSettings | undefined {
  const { members } = settings;
  if (members.length < 2) return undefined;
  const at = members.findIndex((member) => member.hostId === settings.hostId);
  if (at === -1) return undefined;
  const next = members[(at + 1) % members.length];
  if (next === undefined || next.hostId === settings.hostId) return undefined;
  return {
    ...settings,
    hostId: next.hostId,
    hostName: next.hostName,
    hostKey: next.hostKey,
    directUrl: next.directUrl,
  };
}

/**
 * The members that refused this device as unknown (4401) since the app last reached one (#2759).
 *
 * A retry moves the attempt along the roster, so a dropped session can land on a member that never paired this device.
 * Its refusal says nothing about the host this device is paired with, which still lists it. The device is unknown only
 * once every member of the roster has refused it; until then the attempt moves on.
 */
export class UnknownDeviceRefusals {
  readonly #refused = new Set<string>();

  /** Records `settings`' selected member as refusing; true when every member of the roster has now refused. */
  refusedBy(settings: ConnectionSettings): boolean {
    this.#refused.add(settings.hostId);
    const hosts = settings.members.length === 0 ? [settings.hostId] : settings.members.map((member) => member.hostId);
    return hosts.every((hostId) => this.#refused.has(hostId));
  }

  clear(): void {
    this.#refused.clear();
  }
}
