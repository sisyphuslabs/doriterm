import type { ConnectionSettings, MemberTarget } from "./settings.ts";

/** Whether a member's dial settings are unchanged, so an edit elsewhere does not tear down a connection it does not concern. */
export const sameTarget = (held: ConnectionSettings, want: ConnectionSettings): boolean =>
  held.mode === want.mode &&
  held.relayUrl === want.relayUrl &&
  held.hostId === want.hostId &&
  held.hostName === want.hostName &&
  held.hostKey === want.hostKey &&
  held.viewMember === want.viewMember &&
  held.keySlot === want.keySlot &&
  held.meshId === want.meshId &&
  held.directUrl === want.directUrl &&
  held.loopbackUrl === want.loopbackUrl &&
  held.token === want.token;

/**
 * The mesh and key slot a member is dialled as. Set explicitly either way, never inherited from the shared settings: a
 * slot that ever reached them would otherwise make every paired machine offer that mesh's key (review of #2890).
 */
const meshOf = (member: MemberTarget, learned: boolean) => ({
  keySlot: learned ? member.keySlot : undefined,
  meshId: learned ? member.meshId : undefined,
});

/** One member's settings: the shared ones, with that member's own address and a roster of just itself. */
export function scopedSettings(shared: ConnectionSettings, member: MemberTarget, learned: boolean): ConnectionSettings {
  return {
    ...shared,
    ...(learned ? { mode: "relay", viewMember: true } : {}),
    ...meshOf(member, learned),
    hostId: member.hostId,
    hostName: member.hostName,
    hostKey: member.hostKey,
    directUrl: member.directUrl,
    members: [member],
  };
}

/** The settings a shown machine other than the saved one is seen with: its address, and its mesh when it was learned. */
export function shownSettings(shared: ConnectionSettings, shown: MemberTarget, learned: boolean): ConnectionSettings {
  return {
    ...shared,
    ...shown,
    ...(learned ? { mode: "relay", viewMember: true } : {}),
    ...meshOf(shown, learned),
  };
}
