// The browser's own mesh join, reachable from a page: the test-only entry `mesh-join-browser.e2e.ts` bundles and serves
// to one page of the real app, because no shipped route reaches `src/mesh/join.ts` yet (the join UI is stage 4 of #1386).
// Nothing under `src/` imports this file and the app's build does not include it, so it puts no code in front of a user.
// Every function here runs in the page: `joinMesh` and `connect` are called with no deps, so the join uses the page's own
// WebCrypto device key, its own Ed25519 signing key and its own IndexedDB store.
import { connect } from "../src/connection/connect.ts";
import { loadDeviceKey } from "../src/connection/device-key.ts";
import { DEFAULT_SETTINGS } from "../src/connection/settings.ts";
import { joinMesh } from "../src/mesh/join.ts";
import { MembershipStore, membersOf, type MeshMember, reachableTargets } from "../src/mesh/membership.ts";
import { parsePairingFragment } from "../src/pair/fragment.ts";

/** What the page joined: the mesh, its own signing key, and every member the checked welcome named. */
export interface Joined {
  readonly meshId: string;
  readonly signPub: string;
  readonly hostId: string;
  readonly members: readonly MeshMember[];
}

/** One session the page opened to a machine, as the connection reported it. */
export interface Reached {
  readonly path: string;
  readonly framed: boolean;
  readonly hostId: string;
  readonly terminals: readonly string[];
}

const membership = new MembershipStore();

const summary = (member: MeshMember): MeshMember => ({
  signPub: member.signPub,
  hostId: member.hostId,
  name: member.name,
  noisePub: member.noisePub,
  kind: member.kind,
});

/** Joins the mesh `hash` names, from the page, as `deviceName` slugged to a member name (the future join UI's call). */
export async function join(hash: string, deviceName: string): Promise<Joined> {
  const parsed = parsePairingFragment(hash);
  if (!parsed.ok) throw new Error(parsed.reason);
  const joined = await joinMesh(parsed.offer, deviceName);
  const own = joined.members.find((member) => member.signPub === joined.membership.signPub);
  if (own === undefined) throw new Error("the welcome named no member with this browser's key");
  return {
    meshId: joined.meshId,
    signPub: joined.membership.signPub,
    hostId: own.hostId,
    members: joined.members.map(summary),
  };
}

/** The membership this page reads from its own IndexedDB now, or null: what a reload has to find still there. */
export async function stored(): Promise<{ readonly meshId: string; readonly signPub: string } | null> {
  const held = await membership.read();
  return held === undefined ? null : { meshId: held.meshId, signPub: held.signPub };
}

/** `webcrypto` when the page's device key is a non-extractable CryptoKey in IndexedDB, `raw` when it fell back to bytes. */
export async function deviceKeyKind(): Promise<string> {
  return (await loadDeviceKey()).kind;
}

/**
 * Opens a session to the machine `hostId` over the relay the membership was joined through, and lists its terminals: the
 * same call the app makes, from the roster the signed welcome gave this browser rather than from a pairing of its own.
 */
export async function reach(hostId: string): Promise<Reached> {
  const held = await membership.read();
  if (held === undefined) throw new Error("this page is not in a mesh");
  const target = reachableTargets(membersOf(held.records)).find((member) => member.hostId === hostId);
  if (target === undefined) throw new Error(`${hostId} is not a machine this membership holds`);
  const opened = await connect({ ...DEFAULT_SETTINGS, mode: "relay", relayUrl: held.relayUrl, ...target });
  try {
    const answer = await opened.connection.call("terminal.list", {});
    return {
      path: opened.path,
      framed: opened.connection.hello.framed,
      hostId,
      terminals: answer.terminals.flatMap((terminal) => (typeof terminal.name === "string" ? [terminal.name] : [])),
    };
  } finally {
    opened.connection.close();
  }
}
