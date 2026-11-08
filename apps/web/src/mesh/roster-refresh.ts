import { JOINER_EXPECTS, MeshLines, byDeadline } from "@doriface/mesh/join";
import { loadBrowserIdentity } from "../mesh/identity.ts";
import { connectionStore } from "../connection/store.ts";
import { deviceStore } from "../storage/idb.ts";
import { deviceName } from "../pair/device-name.ts";
import { openRosterSession } from "./join.ts";
import { membershipBundle, prepareMembership, forgetMembership } from "./membership-state.ts";
import type { MembershipStore } from "./membership.ts";
import { exchangeRoster } from "./roster-client.ts";
import { meshNameOf } from "./member-name.ts";

const tried = new WeakSet<object>();
const failures = new Map<string, string>();
/** When each settling machine was last asked for the roster. */
const asked = new Map<string, number>();
const SETTLING_ASK_MS = 60_000;
export const rosterFailure = (hostId: string) => failures.get(hostId);

async function nameForBrowser(): Promise<string> {
  const name = membershipBundle()?.snapshot().self?.name ?? (await deviceStore.get("mesh.browser-name"));
  return typeof name === "string" ? name : meshNameOf(deviceName());
}

type Entry = ReturnType<typeof connectionStore.entries>[number];

async function refreshFrom(entry: Entry, claimed: (bundle: MembershipStore) => boolean): Promise<void> {
  const bundle = await prepareMembership();
  if (!claimed(bundle)) return;
  const identity = await loadBrowserIdentity();
  const secure = await openRosterSession({ ...entry.target, relayUrl: connectionStore.settings.relayUrl }, identity);
  const lines = new MeshLines(secure, JOINER_EXPECTS);
  try {
    await byDeadline(
      exchangeRoster(lines, {
        identity,
        bundle,
        source: entry.target,
        relayUrl: connectionStore.settings.relayUrl,
        name: await nameForBrowser(),
        action: "refresh",
      }),
      Date.now() + 30_000,
      "The roster did not arrive in time.",
    );
    failures.delete(entry.target.hostId);
  } finally {
    lines.close(1000, "roster complete");
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

/** Leave reaches any online machine, and local custody is deleted only after the verified revoke arrives. */
export async function leaveMembership(): Promise<void> {
  const bundle = membershipBundle();
  if (bundle === undefined || bundle.snapshot().phase !== "joined") throw new Error("This browser is not in a mesh.");
  const target = connectionStore
    .entries()
    .find(
      (entry) =>
        entry.state.phase === "open" &&
        bundle.snapshot().machines.some((member) => member.hostId === entry.target.hostId),
    );
  if (target === undefined) throw new Error("No machine is reachable. You can forget this mesh here.");
  const identity = await loadBrowserIdentity();
  const session = await openRosterSession({ ...target.target, relayUrl: connectionStore.settings.relayUrl }, identity);
  const lines = new MeshLines(session, JOINER_EXPECTS);
  try {
    await byDeadline(
      exchangeRoster(lines, { identity, bundle, source: target.target, name: await nameForBrowser(), action: "leave" }),
      Date.now() + 30_000,
      "The machine did not confirm leaving in time.",
    );
  } finally {
    lines.close(1000, "leave complete");
  }
  await forgetMembership();
}
