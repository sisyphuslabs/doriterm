import { JOINER_EXPECTS, MeshLines, byDeadline } from "@doriface/mesh/join";
import { loadBrowserIdentity } from "../connection/browser-identity.ts";
import { connectionStore } from "../connection/store.ts";
import { deviceStore } from "../storage/idb.ts";
import { deviceName } from "../pair/device-name.ts";
import { openRosterSession } from "../pair/join-session.ts";
import { membershipBundle, prepareMembership, forgetMembership } from "./browser-membership.ts";
import { exchangeRoster } from "./roster-client.ts";

const tried = new WeakSet<object>();
const failures = new Map<string, string>();
export const rosterFailure = (hostId: string) => failures.get(hostId);

async function nameForBrowser(): Promise<string> {
  const name = membershipBundle()?.snapshot().self?.name ?? await deviceStore.get("mesh.browser-name");
  return typeof name === "string" ? name : deviceName().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 32);
}

/** A member's own open session triggers one bounded refresh; older hosts leave the existing roster untouched. */
export function followRoster(): () => void {
  let stopped = false;
  const read = (): void => {
    for (const entry of connectionStore.entries()) {
      if (entry.state.phase !== "open" || entry.state.path === "loopback" || tried.has(entry.state.connection)) continue;
      const session = entry.state.connection;
      tried.add(session);
      void (async () => {
        const bundle = await prepareMembership();
        if (stopped || !bundle.claimRefresh(entry.target.hostId, session)) return;
        const identity = await loadBrowserIdentity();
        const secure = await openRosterSession({ ...entry.target, relayUrl: connectionStore.settings.relayUrl }, identity);
        const lines = new MeshLines(secure, JOINER_EXPECTS);
        try {
          await byDeadline(exchangeRoster(lines, { identity, bundle, source: entry.target, name: await nameForBrowser(), action: "refresh" }), Date.now() + 30_000, "The roster did not arrive in time.");
          failures.delete(entry.target.hostId);
        } finally {
          lines.close(1000, "roster complete");
        }
      })().catch((error: unknown) => {
        failures.set(entry.target.hostId, error instanceof Error ? error.message : String(error));
      });
    }
  };
  const off = connectionStore.subscribe(read);
  read();
  return () => { stopped = true; off(); };
}

/** Leave reaches any online machine, and local custody is deleted only after the verified revoke arrives. */
export async function leaveMembership(): Promise<void> {
  const bundle = membershipBundle();
  if (bundle === undefined || bundle.snapshot().phase !== "joined") throw new Error("This browser is not in a mesh.");
  const target = connectionStore.entries().find((entry) => entry.state.phase === "open" &&
    bundle.snapshot().machines.some((member) => member.hostId === entry.target.hostId));
  if (target === undefined) throw new Error("No machine is reachable. You can forget this mesh here.");
  const identity = await loadBrowserIdentity();
  const session = await openRosterSession({ ...target.target, relayUrl: connectionStore.settings.relayUrl }, identity);
  const lines = new MeshLines(session, JOINER_EXPECTS);
  try {
    await byDeadline(exchangeRoster(lines, { identity, bundle, source: target.target, name: await nameForBrowser(), action: "leave" }), Date.now() + 30_000, "The machine did not confirm leaving in time.");
  } finally {
    lines.close(1000, "leave complete");
  }
  await forgetMembership();
}
