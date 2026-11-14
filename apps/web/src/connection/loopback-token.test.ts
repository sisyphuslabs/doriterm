import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openPushLink } from "../push/push-route.ts";
import { connect } from "./connect.ts";
import { type ConnectionSettings, DEFAULT_SETTINGS } from "./settings.ts";

const TOKEN = "loopback-token-must-stay-on-this-computer";

/**
 * A listener on every interface that records each request's subprotocols (where the token travels) and refuses the
 * upgrade, so a dial that reaches it fails fast instead of waiting for a host that is not there.
 */
let server: ReturnType<typeof Bun.serve>;
const seen: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request) {
      seen.push(request.headers.get("sec-websocket-protocol") ?? "");
      return new Response("refused by the test listener", { status: 403 });
    },
  });
});

afterAll(() => {
  void server.stop(true);
});

const loopbackSettings = (loopbackUrl: string): ConnectionSettings => ({
  ...DEFAULT_SETTINGS,
  mode: "loopback",
  loopbackUrl,
  token: TOKEN,
});

const outcome = (attempt: Promise<unknown>): Promise<string> =>
  attempt.then(
    () => "connected",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe("the loopback token only ever goes to this computer (#462)", () => {
  test("a loopbackUrl on another address is refused before any request, so the token is never sent", async () => {
    const before = seen.length;
    const message = await outcome(connect(loopbackSettings(`ws://0.0.0.0:${server.port}/v1/hc`)));
    expect(seen.slice(before)).toEqual([]);
    expect(message).toContain("this computer");
  });

  test("a saved push route on another address is refused the same way, the service worker's included", async () => {
    const before = seen.length;
    const message = await outcome(
      openPushLink({ mode: "loopback", pushUrl: `ws://0.0.0.0:${server.port}/v1/push`, token: TOKEN }),
    );
    expect(seen.slice(before)).toEqual([]);
    expect(message).toContain("this computer");
  });

  test("a loopback address is still dialed with the token (the listener is reachable at all)", async () => {
    const before = seen.length;
    await outcome(connect(loopbackSettings(`ws://127.0.0.1:${server.port}/v1/hc`)));
    // The refused dial is followed by one tokenless probe of the same port (#2003); only the dial carries the token.
    const carrying = seen.slice(before).filter((protocols) => protocols.includes(`doriface.token.${TOKEN}`));
    expect(carrying).toHaveLength(1);
    expect(seen.slice(before).length - carrying.length).toBeLessThanOrEqual(1);
  });
});
