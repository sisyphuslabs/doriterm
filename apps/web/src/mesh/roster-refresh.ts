import { JOINER_EXPECTS, MeshLines, byDeadline } from "@doriface/mesh/join";
import { type BrowserIdentity, loadBrowserIdentity } from "../mesh/identity.ts";
import { connectionStore } from "../connection/store.ts";
import type { MemberTarget } from "../connection/settings.ts";
import { deviceStore } from "../storage/idb.ts";
import { deviceName } from "../pair/device-name.ts";
import { DEFAULT_SLOT, slotKeys } from "./identity-slots.ts";
import { openRosterSession } from "./join.ts";
import { enrollFor } from "./join-claim.ts";
import { forgetMembership } from "./membership-lifecycle.ts";
import { inViewSlot, membershipBundle, prepareMembership } from "./membership-state.ts";
import type { MembershipStore } from "./membership.ts";
import { exchangeRoster, type RosterContext } from "./roster-client.ts";
import { meshNameOf } from "./member-name.ts";

const tried = new WeakSet<object>();
const failures = new Map<string, string>();
/** When each settling machine was last asked for the roster. */
const asked = new Map<string, number>();
const SETTLING_ASK_MS = 60_000;
export const rosterFailure = (hostId: string) => failures.get(hostId);

async function nameForBrowser(bundle: MembershipStore): Promise<string> {
  const name = bundle.snapshot().self?.name ?? (await deviceStore.get("mesh.browser-name"));
  return typeof name === "string" ? name : meshNameOf(deviceName());
}

type Entry = ReturnType<typeof connectionStore.entries>[number];

/** What a roster conversation needs from the page; the tests replace it to see which identity each one runs as. */
export interface RosterDeps {
  readonly prepare: (slot: string) => Promise<MembershipStore>;
  readonly identity: (slot: string) => Promise<BrowserIdentity>;
  readonly talk: (member: MemberTarget, context: RosterContext) => Promise<void>;
  readonly forget: (slot: string) => Promise<void>;
  readonly bundle: (slot: string) => MembershipStore | undefined;
  /** Enrolls a store that holds no mesh before a roster may take it in (`enrollFor`); undefined when it may not. */
  readonly enroll: (bundle: MembershipStore) => Promise<(() => Promise<void>) | undefined>;
}

async function talkTo(member: MemberTarget, context: RosterContext): Promise<void> {
  const relayUrl = connectionStore.settings.relayUrl;
  const secure = await openRosterSession({ ...member, relayUrl }, context.identity);
  const lines = new MeshLines(secure, JOINER_EXPECTS);
  try {
    const late =
      context.action === "leave"
        ? "The machine did not confirm leaving in time."
        : "The roster did not arrive in time.";
    await byDeadline(exchangeRoster(lines, context), Date.now() + 30_000, late);
  } finally {
    lines.close(1000, "roster complete");
  }
}

const BROWSER: RosterDeps = {
  prepare: prepareMembership,
  // Through `slotKeys`: an enrolled identity is only read here, never created again (review of #2890).
  identity: (slot) => loadBrowserIdentity(slotKeys(deviceStore, slot)),
  talk: talkTo,
  forget: (slot) => forgetMembership(slot),
  bundle: membershipBundle,
  enroll: enrollFor,
};

/** A machine learned from a mesh is asked as that mesh's member, with the keys that mesh knows; a paired one as before. */
export async function refreshFrom(
  entry: Entry,
  claimed: (bundle: MembershipStore) => boolean,
  deps: RosterDeps = BROWSER,
): Promise<void> {
  const slot = entry.target.keySlot ?? DEFAULT_SLOT;
  const bundle = await deps.prepare(slot);
  if (!claimed(bundle)) return;
  // A roster that would take this browser in is an enrollment, made before the keys are loaded for it.
  const finish = bundle.snapshot().phase === "empty" ? await deps.enroll(bundle) : async () => undefined;
  if (finish === undefined) return;
  try {
    const identity = await deps.identity(slot);
    await deps.talk(entry.target, {
      identity,
      bundle,
      source: entry.target,
      relayUrl: connectionStore.settings.relayUrl,
      name: await nameForBrowser(bundle),
      action: "refresh",
    });
    failures.delete(entry.target.hostId);
  } finally {
    await finish();
  }
}

/**
 * A member's own open session triggers one bounded refresh; older hosts leave the existing roster untouched. A machine
 * that keeps refusing this browser while it is settling is asked too, at most once a minute: a machine that removed
 * the browser still serves it the records up to that removal on the roster stream, and that refresh is how the browser
 * learns it was removed (design 10.3). A machine that has not learned the browser yet refuses the session.
 */
export function followRoster(): () => void {
  let stopped = false;
  const refresh = (entry: Entry, claimed: (bundle: MembershipStore) => boolean): void => {
    void refreshFrom(entry, (bundle) => !stopped && claimed(bundle)).catch((error: unknown) => {
      failures.set(entry.target.hostId, error instanceof Error ? error.message : String(error));
    });
  };
  const read = (): void => {
    for (const entry of connectionStore.entries()) {
      const { state } = entry;
      if (state.phase === "failed" && state.settling === true) {
        const hostId = entry.target.hostId;
        const now = Date.now();
        if (now - (asked.get(hostId) ?? 0) < SETTLING_ASK_MS) continue;
        asked.set(hostId, now);
        refresh(entry, (bundle) => bundle.snapshot().phase === "joined");
        continue;
      }
      if (state.phase !== "open" || state.path === "loopback" || tried.has(state.connection)) continue;
      const session = state.connection;
      tried.add(session);
      refresh(entry, (bundle) => bundle.claimRefresh(entry.target.hostId, session));
    }
  };
  const off = connectionStore.subscribe(read);
  read();
  return () => {
    stopped = true;
    off();
  };
}

/**
 * Leaves one mesh (the one in view) through any of its online machines, as that mesh's own identity, and forgets that
 * mesh only after the verified revoke arrives; every other mesh this browser holds stays.
 */
export async function leaveMembership(
  slot: string = inViewSlot(),
  entries: readonly Entry[] = connectionStore.entries(),
  deps: RosterDeps = BROWSER,
): Promise<void> {
  const bundle = deps.bundle(slot);
  if (bundle === undefined || bundle.snapshot().phase !== "joined") throw new Error("This browser is not in a mesh.");
  const target = entries.find(
    (entry) =>
      entry.state.phase === "open" &&
      bundle.snapshot().machines.some((member) => member.hostId === entry.target.hostId),
  );
  if (target === undefined) throw new Error("No machine is reachable. You can forget this mesh here.");
  await deps.talk(target.target, {
    identity: await deps.identity(slot),
    bundle,
    source: target.target,
    name: await nameForBrowser(bundle),
    action: "leave",
  });
  await deps.forget(slot);
}
