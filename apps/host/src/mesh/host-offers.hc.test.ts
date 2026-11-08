import { HcConnection } from "@doriface/client";
import { MESH_OFFER_DOC, parseMeshOfferDoc } from "@doriface/protocol";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken, SUBPROTOCOL } from "../auth.ts";
import { startHost } from "../host.ts";
import { createHcSession } from "../testing/hc-session.ts";
import { spawnHcLink } from "./hc-machines.ts";

/** The `hc connect` processes still serving this session, by their own command line. */
function connectsOf(session: string): number[] {
  const listed = Bun.spawnSync(["pgrep", "-f", `hc connect --session ${session}`], { stdout: "pipe" });
  return listed.stdout
    .toString()
    .split("\n")
    .filter((line) => line !== "")
    .map(Number);
}

test("a stopped host leaves no line of its one-line Add a machine service to the core (#668)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dh-host-offers-"));
  const session = createHcSession("dh-host-offers");
  const token = generateToken();
  const host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token,
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir: dir,
    log: () => {},
  });
  // A client pipe starts the host's core-side services, the offer service among them.
  const ws = new WebSocket(host.url, [SUBPROTOCOL, `doriface.token.${token}`]);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const link = spawnHcLink({ hc: session.hc, session: session.name, env: session.env });
  const core = await HcConnection.open(link);
  try {
    // The service answers a request, so it is running before the host stops.
    const feed = await core.subscribe();
    let changed = Promise.withResolvers<void>();
    feed.onEvent((event) => {
      if (event.type === "doc" && event.data.name === MESH_OFFER_DOC) changed.resolve();
    });
    const { version } = await core.call("doc.get", { name: MESH_OFFER_DOC });
    await core.call("doc.set", { name: MESH_OFFER_DOC, value: { request: "r" }, version });
    // One read at a time, each awaited here: a read still in flight when the connection closes below would be failed
    // by that close with nobody waiting on it (#1004).
    const answered = async (): Promise<void> => {
      await changed.promise;
      changed = Promise.withResolvers<void>();
      const doc = parseMeshOfferDoc((await core.call("doc.get", { name: MESH_OFFER_DOC })).value);
      if (doc === undefined || Object.keys(doc).length <= 1) return answered();
    };
    await answered();
    feed.close();
  } finally {
    core.close();
    link.close();
  }
  const before = connectsOf(session.name);
  expect(before.length).toBeGreaterThan(0);
  ws.close();
  await host.stop();
  // Every `hc connect` the host started is gone once stop settles, so nothing can start the core again.
  expect(connectsOf(session.name)).toEqual([]);
  await session.dispose();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);
