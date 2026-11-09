import { expect, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import { MeshDevice, MeshMachineList } from "./mesh-device.tsx";

const entries: readonly MemberEntry[] = [
  {
    target: { hostId: "alpha", hostName: "Alpha", hostKey: "", directUrl: "" },
    state: { phase: "failed", error: new Error("offline"), retryInMs: 1_000, retryAt: 0, stale: null },
  },
  {
    target: { hostId: "beta", hostName: "Beta", hostKey: "", directUrl: "" },
    state: { phase: "connecting", attempt: 1, stale: null },
  },
];

const addresses = { relayUrl: "wss://relay.example.dev", loopbackUrl: "" };
const connection = { hello: {} } as HcConnection;

test("This device names the browser itself, without a host row", () => {
  const html = renderToStaticMarkup(
    <MeshDevice name="Pixel 9" mesh="My mesh" fingerprint="ABCD" installed={false} online={1} onLeave={() => {}} />,
  );
  expect(html).toContain("Pixel 9");
  expect(html).toContain("Member of My mesh");
  expect(html).toContain("1 machines online");
  expect(html).not.toContain("This machine");
  expect(html).not.toContain("Host");
});

test("all browser machines have the same row shape and no special inviter", () => {
  const html = renderToStaticMarkup(
    <MeshMachineList entries={entries} ownComputer={undefined} addresses={addresses} retry={() => {}} />,
  );
  expect(html).toContain("Alpha");
  expect(html).toContain("Beta");
  expect(html).toContain("Offline");
  expect(html).not.toContain("This machine");
  expect(html).not.toContain("joined through");
  expect(html).not.toContain("Relay");
  expect(html.match(/No session now/g)).toHaveLength(2);
});

test("each open machine names the route its own session took, and how it is connected", () => {
  const open: readonly MemberEntry[] = [
    {
      target: { hostId: "lan-box", hostName: "Lan box", hostKey: "", directUrl: "https://192.0.2.10:7766" },
      state: { phase: "open", connection, path: "direct", connectMs: 42 },
    },
    {
      target: { hostId: "far-box", hostName: "Far box", hostKey: "", directUrl: "" },
      state: { phase: "open", connection, path: "relay", connectMs: 310 },
    },
  ];
  const html = renderToStaticMarkup(
    <MeshMachineList entries={open} ownComputer={undefined} addresses={addresses} retry={() => {}} />,
  );
  expect(html).toContain("Online · Direct");
  expect(html).toContain("Direct to 192.0.2.10:7766 · end-to-end encrypted");
  expect(html).toContain("Opened in 42 ms");
  expect(html).toContain("Online · Relay");
  expect(html).toContain("Through the relay relay.example.dev · end-to-end encrypted");
  expect(html).toContain("Peer id lan-box");
  expect(html).toContain("Peer id far-box");
});

test("a member's key is shown as its fingerprint, never as the raw key", () => {
  const hostKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
  const html = renderToStaticMarkup(
    <MeshMachineList
      entries={[
        {
          target: { hostId: "k", hostName: "Keyed", hostKey, directUrl: "" },
          state: { phase: "connecting", attempt: 1, stale: null },
        },
      ]}
      ownComputer={undefined}
      addresses={addresses}
      retry={() => {}}
    />,
  );
  expect(html).toMatch(/Key [0-9A-F]{4}( [0-9A-F]{4}){9}/);
  expect(html).not.toContain(hostKey);
});

test("only the desktop shell's own computer gets the local marker", () => {
  const html = renderToStaticMarkup(
    <MeshMachineList entries={entries} ownComputer="beta" addresses={addresses} retry={() => {}} />,
  );
  expect(html.match(/This machine/g)).toHaveLength(1);
  expect(html.indexOf("Beta")).toBeLessThan(html.indexOf("This machine"));
});

test("one settling member changes only its own row", () => {
  const [first, second] = entries;
  if (first === undefined || second === undefined) throw new Error("the test requires two machines");
  const settling: MemberEntry = {
    ...first,
    state: { phase: "failed", settling: true, error: new Error("settling"), retryInMs: 1_000, retryAt: 0, stale: null },
  };
  const html = renderToStaticMarkup(
    <MeshMachineList entries={[settling, second]} ownComputer={undefined} addresses={addresses} retry={() => {}} />,
  );
  expect(html.match(/Settling/g)).toHaveLength(1);
  expect(html).toContain("Beta");
});
