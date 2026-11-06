import { generateX25519, type SecureLink } from "@doriface/crypto";
import {
  DEFAULT_PUSH_PREFS,
  encodePushLine,
  type PushClientLine,
  type PushHostLine,
  parsePushHostLine,
} from "@doriface/protocol";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptPushBody, receiverKeys } from "../../apps/host/src/testing/push-receiver.ts";
import { capturingSockets } from "./support/capture.ts";
import { type RelayedHost, startRelayedHost, RELAYED_STOP_MS } from "./support/relayed-host.ts";
import { setUpOnce } from "./support/set-up-once.ts";
import { within } from "./support/watch.ts";
import { killAndRemove } from "./support/terminals.ts";

const scratch = mkdtempSync(join(tmpdir(), "relay-push-"));
const captureFile = join(scratch, "relay-observed.bin");
const phone = generateX25519();
let nextPost = Promise.withResolvers<Uint8Array>();
// The browser's push service stand-in: what the host posts arrives here, never through the relay.
const pushService = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    nextPost.resolve(new Uint8Array(await request.arrayBuffer()));
    return new Response(null, { status: 201 });
  },
});
const FAKE_AGENT = join(import.meta.dir, "..", "..", "apps", "web", "e2e", "fake-permission-agent.ts");
const ENDPOINT = `http://127.0.0.1:${pushService.port}/push/relay-phone`;
let relayed: RelayedHost | undefined;

setUpOnce(async () => {
  relayed = await startRelayedHost("relay-push", {
    wrapSockets: (base) => capturingSockets(captureFile, base),
    pushTestOrigins: [new URL(ENDPOINT).origin],
  });
  await relayed.pair(phone, "push phone");
}, 120_000);

afterAll(async () => {
  await relayed?.stop();
  await pushService.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}, RELAYED_STOP_MS);

/** A push session's lines: each one gets one reply, in order. */
function lines(link: SecureLink): (line: PushClientLine) => Promise<PushHostLine> {
  let buffer = "";
  const waiting: ((line: PushHostLine) => void)[] = [];
  link.onData((bytes) => {
    buffer += new TextDecoder().decode(bytes);
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
      waiting.shift()?.(parsePushHostLine(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  return (line) => {
    const reply = new Promise<PushHostLine>((resolve) => waiting.push(resolve));
    link.send(new TextEncoder().encode(encodePushLine(line)));
    return reply;
  };
}

function hc(args: readonly string[]): string {
  if (relayed === undefined) throw new Error("the push setup did not finish");
  const { session } = relayed;
  const done = Bun.spawnSync([session.hc, ...args], { env: { ...process.env, ...session.env } });
  if (done.exitCode !== 0) throw new Error(`hc ${args.join(" ")}: ${done.stderr.toString()}`);
  return done.stdout.toString();
}

describe("web push through the relay", () => {
  test("the relay carries the push stream and the answer as ciphertext; the notice goes straight to the push service", async () => {
    if (relayed === undefined) throw new Error("the push setup did not finish");
    const keys = await receiverKeys();
    const link = await relayed.dial(phone, "push");
    const ask = lines(link);
    const ready = await ask({ t: "hello" });
    expect(ready.t).toBe("ready");
    const subscription = { endpoint: ENDPOINT, p256dh: keys.p256dh, auth: keys.auth };
    expect(await ask({ t: "subscribe", subscription, prefs: DEFAULT_PUSH_PREFS })).toEqual({ t: "ok" });
    // #192's fake Claude Code agent: it draws Claude Code's own permission dialog and logs every key it gets.
    const keyLog = join(scratch, "keys.log");
    const out = hc(["run", "--bg", "--name", "relay-asker", "--", process.execPath, FAKE_AGENT, keyLog]);
    const agent = String(JSON.parse(out).address);
    const body = await nextPost.promise;
    nextPost = Promise.withResolvers();
    const notice: unknown = JSON.parse(new TextDecoder().decode(await decryptPushBody(body, keys)));
    const id = typeof notice === "object" && notice !== null ? String(Reflect.get(notice, "n")) : "";
    expect(Object.keys(notice ?? {}).toSorted()).toEqual(["h", "k", "n", "v"]);

    // The rows of the agent's dialog travel only on this E2EE stream, never in the payload above (#669).
    expect(await ask({ t: "notice", id })).toMatchObject({
      t: "notice",
      terminal: agent,
      kind: "permission",
      prompt: {
        options: [
          { id: "1", label: "Yes", declines: false },
          { id: "2" },
          { id: "3" },
          { id: "4", label: "No", declines: true },
        ],
      },
    });
    // The agent logs a key as it reads it, after hc delivered it: wait for that write, then read the log.
    const keyed = new Promise<void>((resolve) => {
      const watcher = watch(scratch, (_, name) => {
        if (name !== "keys.log") return;
        watcher.close();
        resolve();
      });
    });
    expect(await ask({ t: "answer", id, answer: "allow" })).toEqual({ t: "answered", terminal: agent });
    await within(keyed, "the agent's key", 10_000);
    expect(readFileSync(keyLog, "utf8").trim().split("\n")).toEqual(['"1"']);
    expect(await ask({ t: "unsubscribe", endpoint: ENDPOINT })).toEqual({ t: "ok" });
    link.close();
    killAndRemove(hc, agent);

    const observed = Buffer.from(readFileSync(captureFile));
    expect(observed.byteLength).toBeGreaterThan(0);
    for (const plain of [
      ENDPOINT,
      keys.p256dh,
      keys.auth,
      id,
      '"t":"subscribe"',
      '"t":"answer"',
      "touch probe-a.txt",
      "relay-asker",
    ]) {
      expect(observed.includes(Buffer.from(plain))).toBe(false);
    }
  }, 120_000);
});
