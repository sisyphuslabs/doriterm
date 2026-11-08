import { browserInvite, joinComparedBrowser } from "./support/compared-browser.ts";
import { base64urlEncode, hostIdOf } from "@doriface/crypto";
import { JOINER_EXPECTS, MeshLines } from "../../packages/mesh/src/join/index.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect } from "../../apps/web/src/connection/connect.ts";
import { DEFAULT_SETTINGS } from "../../apps/web/src/connection/settings.ts";
import { joinMesh, openRosterSession } from "../../apps/web/src/mesh/join.ts";
import { MembershipStore, reachableTargets } from "../../apps/web/src/mesh/membership.ts";
import { parsePairingFragment } from "../../apps/web/src/pair/fragment.ts";
import { memoryStore } from "../../apps/web/src/storage/idb.ts";
import { untilFullMesh } from "./support/mesh/echo.ts";
import { type Mesh, startMesh, TEARDOWN_MS } from "./support/mesh/mesh.ts";
import { scenario } from "./support/mesh/present.ts";
import { meshIdOf, statusOf } from "./support/mesh/status.ts";
import { exchangeRoster } from "../../apps/web/src/mesh/roster-client.ts";
import { MeshConnections } from "../../apps/web/src/connection/mesh-connections.ts";
import { ConnectionStore } from "../../apps/web/src/connection/store.ts";
import { loadBrowserIdentity } from "../../apps/web/src/mesh/identity.ts";

const OFFER_URL = /https:\/\/\S*pair#\S+/;

let mesh: Mesh | undefined;

const running = (): Mesh => {
  if (mesh === undefined) throw new Error("setup failed");
  return mesh;
};

/**
 * The browser as the web app's own modules run it: its X25519 device key and Ed25519 signing key in a memory store, so
 * the join exercises the web joiner, the relay and two real hosts, with no browser-only storage in the way.
 */
async function browser() {
  const logs: string[] = [];
  const storage = memoryStore();
  const identity = await loadBrowserIdentity(storage, null);
  const device = identity.device;
  const sign = identity.card;
  const keys = { signPub: base64urlEncode(sign.publicKey), devicePub: base64urlEncode(device.publicKey) };
  const membership = new MembershipStore(storage, keys);
  const deps = {
    loadDeviceKey: async () => device,
    loadSignKey: async () => sign,
    membership,
    storage,
    log: (line: string) => void logs.push(line),
  };
  return { device, sign, logs, membership, storage, keys, deps, hostId: hostIdOf(sign.publicKey) };
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

  test("a browser admitted by a cold-starts, refreshes and opens a terminal on b after a stops, over the relay", async () => {
    const hosts = running();
    const [a, b] = [hosts.host("a"), hosts.host("b")];
    const relayUrl = a.tap?.url ?? hosts.relay?.url ?? "";
    const offer = await browserInvite(a, relayUrl);
    expect(offer.target).toBe("mesh");

    const web = await browser();
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

    await a.stop();
    const restored = new MembershipStore(web.storage, web.keys);
    await restored.load();
    expect(
      restored
        .snapshot()
        .machines.map((target) => target.hostId)
        .toSorted(),
    ).toEqual([a.hostId, b.hostId].toSorted());
    const transport = hosts.relay?.url ?? relayUrl;
    const roster = new MeshConnections(
      { ...DEFAULT_SETTINGS, relayUrl: transport },
      (settings) =>
        new ConnectionStore(
          settings,
          (target, options) =>
            connect({ ...target, relayUrl: transport }, options, { loadDeviceKey: web.deps.loadDeviceKey }),
          () => undefined,
        ),
    );
    roster.setViewMembers(restored.snapshot().machines);
    roster.start();
    try {
      await hosts.until("browser connects to b with a stopped", () =>
        roster.entries().some((entry) => entry.target.hostId === b.hostId && entry.state.phase === "open"),
      );
      roster.select(b.hostId);
      const state = roster.state;
      if (state.phase !== "open") throw new Error("b did not open");
      expect(state.path).toBe("relay");
      expect(roster.entries().find((entry) => entry.target.hostId === a.hostId)?.state.phase).not.toBe("open");
      const terminal = await state.connection.call("terminal.run", { argv: ["/bin/sh"] });
      expect((await state.connection.call("terminal.get", { terminal: terminal.address })).state).toBe("live");
      await state.connection.call("terminal.kill", { terminal: terminal.address });
      await state.connection.call("terminal.rm", { terminal: terminal.address });
      const browserIdentity = { device: web.device, card: web.sign };
      const secure = await openRosterSession({ ...toB, relayUrl: transport }, browserIdentity);
      await exchangeRoster(new MeshLines(secure, JOINER_EXPECTS), {
        identity: browserIdentity,
        bundle: restored,
        source: toB,
        name: "chrome-on-macos",
        action: "refresh",
      });
      expect(restored.snapshot().phase).toBe("joined");
      expect(restored.snapshot().machines.map((target) => target.hostId)).toContain(b.hostId);
    } finally {
      roster.stop();
      await a.start();
    }
  }, 180_000);

  test("a second join by the same browser is refused before anything is dialed: it is a member already", async () => {
    const hosts = running();
    const a = hosts.host("a");
    const web = await browser();
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
