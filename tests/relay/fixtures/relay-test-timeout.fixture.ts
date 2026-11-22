import { afterEach, expect, test } from "bun:test";
import { runDeferred } from "../support/cleanup.ts";
import { testIp } from "../support/probe.ts";
import { startRawHost } from "../support/raw-host.ts";
import { useLocalRelay } from "../support/relay-fixture.ts";

afterEach(runDeferred);
const relay = useLocalRelay();
let firstUrl: string;

test("a test blocked on an open socket times out", async () => {
  firstUrl = relay.url;
  const host = await startRawHost(relay.url, testIp());
  console.log("waiting for the authenticated socket to close");
  await host.probe.closed;
});

test("the next test can reach its relay", async () => {
  expect(relay.url).toBe(firstUrl);
  expect((await fetch(`${relay.url}/healthz`)).status).toBe(200);
});
