import { expect, test } from "bun:test";
import { RelayCloseError } from "@doriface/relay-client";
import { REFUSALS } from "../../../host/src/connect/dial.ts";
import type { MemberEntry } from "../../../host/src/mesh/authorize-index.ts";
import { DialPolicy } from "../../../host/src/mesh/dial-policy.ts";
import { BUDGET_REFUSAL, LineGrants } from "../../../host/src/mesh/line-grants.ts";
import { NoUplinkError } from "../../../host/src/mesh/no-uplink.ts";
import { FakeClock, seededRandom } from "../../../host/src/mesh/testing/fake-clock.ts";
import { machineCause } from "./machine-cause.ts";

const unreachable = (why: string) => machineCause({ name: "box", state: "unreachable", why });
const fallback = unreachable("")?.detail;
/** hc's `why` for a failed via: `cannot reach <via command>: <the line it printed>` (measured on hc 0.1.20). */
const viaWhy = (via: string, line: string): string => `cannot reach ${via}: ${line}`;
const connectWhy = (code: number): string => viaWhy("doriface-host connect h1", `${REFUSALS[code]?.("h1")} (${code})`);

test("every refusal doriface-host prints reads as its own cause, never the generic one", () => {
  for (const code of Object.keys(REFUSALS).map(Number)) {
    expect({ code, detail: unreachable(connectWhy(code))?.detail }).not.toEqual({ code, detail: fallback });
  }
});

const box: MemberEntry = {
  signPub: "sign-box",
  hostId: "h-box",
  noisePub: "noise-box",
  devicePub: undefined,
  name: "box",
  hcId: "hc-box",
};

/** The running host's answer to `connect --mesh` for `box`, from line-grants itself, with `setUp` applied first. */
async function lineRefusal(
  setUp: (policy: DialPolicy, clock: FakeClock) => void,
  dial: () => Promise<never> = () => Promise.reject(new Error("no dial expected")),
  hostId = box.hostId,
): Promise<string> {
  const clock = new FakeClock();
  const policy = new DialPolicy({ clock, random: seededRandom(3), onDue: () => undefined });
  setUp(policy, clock);
  const grants = new LineGrants({ view: () => ({ members: [box], revoked: [] }), policy, dial, waitMs: 0, clock });
  const grant = await grants.grant(hostId);
  if (grant.ok) throw new Error("the line was granted");
  return grant.reason;
}

const meshWhy = (line: string): string => viaWhy(`doriface-host connect --mesh ${box.hostId}`, line);
const offline = (policy: DialPolicy): void => {
  while (policy.gate(box.signPub) === undefined) policy.report(box.signPub, 4404);
};

test("a mesh line refused as offline or rate limited reads as the same refusal from doriface-host connect", async () => {
  const lineOffline = await lineRefusal(offline);
  expect(unreachable(meshWhy(lineOffline))?.detail).toBe(unreachable(connectWhy(4404))?.detail);
  const relayClosed = await lineRefusal(
    () => undefined,
    () => Promise.reject(new RelayCloseError(4404, "host not connected")),
  );
  expect(unreachable(meshWhy(relayClosed))?.detail).toBe(unreachable(connectWhy(4404))?.detail);
  const limited = await lineRefusal((policy) => policy.report(box.signPub, 4429));
  expect(unreachable(meshWhy(limited))?.detail).toBe(unreachable(connectWhy(4429))?.detail);
});

test("every other refusal a mesh line gives reads as its own cause, never the generic one", async () => {
  const lines = {
    "not a member": await lineRefusal(() => undefined, undefined, "h-gone"),
    settling: await lineRefusal((policy, clock) => policy.uplinkReturned(() => [], clock.now())),
    "no uplink": await lineRefusal(
      () => undefined,
      () => Promise.reject(new NoUplinkError()),
    ),
    budget: BUDGET_REFUSAL,
    // apps/host/src/connect/mesh-bridge.ts: the bridge's own line when no doriface-host answers on line.sock.
    "host not running": "doriface-host is not running",
  };
  for (const [kind, line] of Object.entries(lines)) {
    expect({ kind, detail: unreachable(meshWhy(line))?.detail }).not.toEqual({ kind, detail: fallback });
  }
});

test("a member that left the mesh is not said to come back by itself", async () => {
  const line = await lineRefusal(() => undefined, undefined, "h-gone");
  expect(unreachable(meshWhy(line))?.detail).not.toContain("keeps trying");
});
