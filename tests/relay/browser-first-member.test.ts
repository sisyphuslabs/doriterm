import { browserInvite, joinComparedBrowser } from "./support/compared-browser.ts";
import { generateEd25519, generateX25519, hostIdOf, rawStaticKey } from "@doriface/crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { connect } from "../../apps/web/src/connection/connect.ts";
import { DEFAULT_SETTINGS } from "../../apps/web/src/connection/settings.ts";
import { joinMesh } from "../../apps/web/src/mesh/join.ts";
import { MembershipStore, reachableTargets } from "../../apps/web/src/mesh/membership.ts";
import { parsePairingFragment } from "../../apps/web/src/pair/fragment.ts";
import { memoryStore } from "../../apps/web/src/storage/idb.ts";
import { DEVICE_LINK_REFUSAL } from "../../packages/mesh/src/join/index.ts";
import type { CliResult } from "./support/mesh/mesh-host.ts";
import { type Mesh, startMesh, TEARDOWN_MS } from "./support/mesh/mesh.ts";
import { scenario } from "./support/mesh/present.ts";
import { meshIdOf, statusOf } from "./support/mesh/status.ts";

const OFFER_URL = /https:\/\/\S*pair#\S+/;

let mesh: Mesh | undefined;

const running = (): Mesh => {
  if (mesh === undefined) throw new Error("setup failed");
  return mesh;
};

/**
 * The browser as the web app's own modules run it: its X25519 device key and Ed25519 signing key in a memory store, so
 * the join exercises the web joiner, the relay and one real host, with no browser-only storage in the way.
 */
function browser() {
  const device = rawStaticKey(generateX25519());
  const sign = generateEd25519();
  const logs: string[] = [];
  const storage = memoryStore();
  const membership = new MembershipStore(storage);
  const deps = {
    loadDeviceKey: async () => device,
    loadSignKey: async () => sign,
    membership,
    storage,
    log: (line: string) => void logs.push(line),
  };
  return { device, sign, logs, membership, storage, deps, hostId: hostIdOf(sign.publicKey) };
}

function offerUrl(run: CliResult, what: string): string {
  const url = OFFER_URL.exec(run.stdout)?.[0];
  if (run.exit !== 0 || url === undefined) throw new Error(`${what} failed: ${run.stderr}${run.stdout}`);
  return url;
}

const meshFile = (stateDir: string): string => join(stateDir, "mesh.json");

scenario("a host with no mesh admits a browser as its first member (#1415)", ["join", "sync"], () => {
  beforeAll(async () => {
    mesh = await startMesh({ names: ["a"] });
  }, 240_000);

  afterAll(async () => {
    const receipt = await mesh?.dispose();
    expect([receipt?.alive, receipt?.listening]).toEqual([[], []]);
  }, TEARDOWN_MS);

  // Before anything joins, so the host is in no mesh: the state the test below founds one from.
  test("a device link is refused before anything is dialed, and the host with no mesh stays in none", async () => {
    const hosts = running();
    const a = hosts.host("a");
    const relayUrl = a.tap?.url ?? hosts.relay?.url ?? "";
    expect(existsSync(meshFile(a.stateDir))).toBe(false);

    const offer = await a.cli("pair", "--no-qr", "--web-origin", "https://web.example", "--relay", relayUrl);
    const parsed = parsePairingFragment(new URL(offerUrl(offer, "pair on a")).hash);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.offer.target).toBe("device");

    const web = browser();
    const outcome = await joinMesh(parsed.offer, "Chrome on macOS", web.deps).then(
      () => "joined",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    // The host's own words for it (`packages/mesh/src/join/invite.ts`), not the web app's rendering of a close code.
    expect(outcome).toBe(DEVICE_LINK_REFUSAL);
    expect(web.logs).toEqual([]);
    expect(await web.membership.read()).toBeUndefined();

    expect(existsSync(meshFile(a.stateDir))).toBe(false);
    expect((await a.cli("mesh", "status", "--json")).exit).not.toBe(0);
  }, 60_000);

  test("by a's mesh invite the browser becomes the first member, and opens a session to a over the relay", async () => {
    const hosts = running();
    const a = hosts.host("a");
    const relayUrl = a.tap?.url ?? hosts.relay?.url ?? "";
    expect(existsSync(meshFile(a.stateDir))).toBe(false);

    const offer = await browserInvite(a, relayUrl);
    expect(offer.target).toBe("mesh");

    const web = browser();
    const joined = await joinComparedBrowser(a, offer, "Chrome on macOS", web);
    expect(joined.meshId).toBe(meshIdOf(a));
    expect(joined.meshId).toBeString();

    const members = (await statusOf(a)).members;
    expect(members.map((member) => member.hostId).toSorted()).toEqual([a.hostId, web.hostId].toSorted());
    expect(members.find((member) => member.hostId === web.hostId)?.name).toBe("chrome-on-macos");
    for (const line of a.logs) expect(line).not.toContain("mesh: close code=4401 source=invite:");

    const targets = reachableTargets(joined.members);
    expect(targets.map((target) => target.hostId)).toEqual([a.hostId]);
    const toA = targets[0];
    if (toA === undefined) throw new Error("a is not among the browser's targets");

    const relayOnly = { ...DEFAULT_SETTINGS, mode: "relay" as const, relayUrl: hosts.relay?.url ?? relayUrl, ...toA };
    const opened = await connect(relayOnly, undefined, { loadDeviceKey: web.deps.loadDeviceKey });
    try {
      expect(opened.path).toBe("relay");
      expect(opened.connection.hello.framed).toBe(true);
      expect((await opened.connection.call("terminal.list", {})).terminals).toBeArray();
    } finally {
      opened.connection.close();
    }
  }, 180_000);
});
