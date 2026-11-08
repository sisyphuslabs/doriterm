import { generateEd25519, generateX25519, hostIdOf, rawStaticKey } from "@doriface/crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect } from "../../apps/web/src/connection/connect.ts";
import { DEFAULT_SETTINGS } from "../../apps/web/src/connection/settings.ts";
import { joinMesh } from "../../apps/web/src/mesh/join.ts";
import { MembershipStore, reachableTargets } from "../../apps/web/src/mesh/membership.ts";
import { parsePairingFragment } from "../../apps/web/src/pair/fragment.ts";
import { memoryStore } from "../../apps/web/src/storage/idb.ts";
import { untilFullMesh } from "./support/mesh/echo.ts";
import { type Mesh, startMesh, TEARDOWN_MS } from "./support/mesh/mesh.ts";
import { scenario } from "./support/mesh/present.ts";
import { browserInvite, joinComparedBrowser } from "./support/compared-browser.ts";
import { meshIdOf, statusOf } from "./support/mesh/status.ts";

const OFFER_URL = /https:\/\/\S*pair#\S+/;

let mesh: Mesh | undefined;

const running = (): Mesh => {
  if (mesh === undefined) throw new Error("setup failed");
  return mesh;
};

/**
 * Browser identity and membership storage for the shared committed ceremony, the relay and two real hosts.
 */
function browser() {
  const device = rawStaticKey(generateX25519());
  const sign = generateEd25519();
  const logs: string[] = [];
  const membership = new MembershipStore(memoryStore());
  const deps = {
    loadDeviceKey: async () => device,
    loadSignKey: async () => sign,
    membership,
    log: (line: string) => void logs.push(line),
  };
  return { device, sign, logs, membership, deps, hostId: hostIdOf(sign.publicKey) };
}

scenario("a browser joins the mesh as its own member (#1386, stage 2)", ["join", "sync"], () => {
  beforeAll(async () => {
    mesh = await startMesh({ names: ["a", "b"] });
    await mesh.join("a", "b");
    await untilFullMesh(mesh, ["a", "b"]);
  }, 240_000);

  afterAll(async () => {
    const receipt = await mesh?.dispose();
    expect([receipt?.alive, receipt?.listening]).toEqual([[], []]);
  }, TEARDOWN_MS);

  test("by a's mesh invite the browser becomes a client member on a AND b, and opens a session to b over the relay", async () => {
    const hosts = running();
    const [a, b] = [hosts.host("a"), hosts.host("b")];
    const relayUrl = a.tap?.url ?? hosts.relay?.url ?? "";
    const offer = await browserInvite(a, relayUrl);
    expect(offer.target).toBe("mesh");

    const web = browser();
    const joined = await joinComparedBrowser(a, offer, "Chrome on macOS", web);
    expect(joined.meshId).toBe(meshIdOf(a));
    expect(joined.membership.signPub).toBeString();

    const aMembers = (await statusOf(a)).members;
    expect(aMembers.map((member) => member.hostId)).toContain(web.hostId);
    expect(aMembers.find((member) => member.hostId === web.hostId)?.name).toBe("chrome-on-macos");
    await hosts.until(
      "b learns the browser's admission from a",
      async () => (await statusOf(b)).members.some((member) => member.hostId === web.hostId),
      120_000,
    );

    // The members the browser can reach come from the signed welcome, not from pairing with each: both machines, no client.
    const targets = reachableTargets(joined.members);
    expect(targets.map((target) => target.hostId).toSorted()).toEqual([a.hostId, b.hostId].toSorted());
    const toB = targets.find((target) => target.hostId === b.hostId);
    if (toB === undefined) throw new Error("b is not among the browser's targets");

    const relayOnly = { ...DEFAULT_SETTINGS, mode: "relay" as const, relayUrl: hosts.relay?.url ?? relayUrl, ...toB };
    const opened = await connect(relayOnly, undefined, { loadDeviceKey: web.deps.loadDeviceKey });
    try {
      expect(opened.path).toBe("relay");
      expect(opened.connection.hello.framed).toBe(true);
      expect((await opened.connection.call("terminal.list", {})).terminals).toBeArray();
    } finally {
      opened.connection.close();
    }
  }, 180_000);

  test("a second join by the same browser is refused before anything is dialed: it is a member already", async () => {
    const hosts = running();
    const a = hosts.host("a");
    const web = browser();
    await web.membership.adopt({
      meshId: meshIdOf(a),
      records: [],
      signPub: "x",
      inviter: { hostId: a.hostId, hostKey: "k" },
      relayUrl: "wss://relay.example",
      joinedAt: new Date().toISOString(),
    });
    const offer = await a.cli(
      "mesh",
      "pair",
      "--auto",
      "--no-qr",
      "--web-origin",
      "https://web.example",
      "--relay",
      a.tap?.url ?? "",
    );
    const url = OFFER_URL.exec(offer.stdout)?.[0];
    if (url === undefined) throw new Error(`mesh pair on a failed: ${offer.stderr}${offer.stdout}`);
    const parsed = parsePairingFragment(new URL(url).hash);
    if (!parsed.ok) throw new Error(parsed.reason);
    const outcome = await joinMesh(parsed.offer, "Safari on iOS", web.deps).then(
      () => "joined",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(outcome).toBe(`this browser is in mesh ${meshIdOf(a)} already`);
    expect(web.logs).toEqual([]);
  }, 60_000);
});
