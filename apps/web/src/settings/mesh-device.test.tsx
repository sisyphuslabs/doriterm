import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import type { HcConnection } from "@doriface/client";
import { MeshDevice, MeshMachineList, measuredConnection } from "./mesh-device.tsx";

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

test("only a live session is measured: one being carried on over a new socket shows no round trip", () => {
  const connection = {} as HcConnection;
  expect(measuredConnection({ phase: "open", connection, path: "relay" })).toBe(connection);
  expect(measuredConnection({ phase: "open", connection, path: "relay", resuming: true })).toBeNull();
  expect(measuredConnection({ phase: "connecting", attempt: 1, stale: connection })).toBeNull();
});

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
  const html = renderToStaticMarkup(<MeshMachineList entries={entries} ownComputer={undefined} retry={() => {}} />);
  expect(html).toContain("Alpha");
  expect(html).toContain("Beta");
  expect(html).toContain("Offline");
  expect(html).not.toContain("This machine");
  expect(html).not.toContain("joined through");
  expect(html.match(/Relay/g)).toHaveLength(2);
});

test("only the desktop shell's own computer gets the local marker", () => {
  const html = renderToStaticMarkup(<MeshMachineList entries={entries} ownComputer="beta" retry={() => {}} />);
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
    <MeshMachineList entries={[settling, second]} ownComputer={undefined} retry={() => {}} />,
  );
  expect(html.match(/Settling/g)).toHaveLength(1);
  expect(html).toContain("Beta");
});
