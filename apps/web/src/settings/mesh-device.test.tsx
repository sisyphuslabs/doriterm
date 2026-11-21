import { expect, test } from "bun:test";
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

type OpenState = Extract<MemberEntry["state"], { readonly phase: "open" }>;

const openMember = (hostName: string, resuming: boolean): MemberEntry => ({
  target: { hostId: hostName.toLowerCase(), hostName, hostKey: "", directUrl: "" },
  state: { phase: "open", connection: {} as OpenState["connection"], path: "relay", resuming },
});

const rowOf = (entry: MemberEntry): string =>
  renderToStaticMarkup(<MeshMachineList entries={[entry]} ownComputer={undefined} retry={() => {}} />);

test("a member whose session is being carried on reads Reconnecting, as the status bar does, not Online (#2421)", () => {
  const carriedOn = rowOf(openMember("Gamma", true));
  expect(carriedOn).toContain("Reconnecting · Relay");
  expect(carriedOn).not.toContain("Online");
  expect(rowOf(openMember("Delta", false))).toContain("Online · Relay");
});
