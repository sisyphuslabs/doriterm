import { describe, expect, test } from "bun:test";
import { CLIENT_FORMAT, writeVersionOf } from "../state/mesh-file.ts";
import type { MemberEntry } from "./authorize-index.ts";
import { formatReadiness } from "./format-readiness.ts";
import { machineKeysOf, machinesOf, type MeshView } from "./mesh-view.ts";

const member = (name: string, kind?: "machine" | "client"): MemberEntry => ({
  signPub: `sign-${name}`,
  hostId: `host-${name}`,
  noisePub: `noise-${name}`,
  devicePub: `device-${name}`,
  name,
  hcId: `hc-${name}`,
  ...(kind === undefined ? {} : { kind }),
});

const viewOf = (...members: readonly MemberEntry[]): MeshView => ({ members, overCap: [], revoked: [] });

describe("the members a host may dial are the machines", () => {
  test("a client is left out of the dialable set but stays in the view, where the status document shows it", () => {
    const view = viewOf(member("studio"), member("phone", "client"));
    expect(view.members.map((entry) => entry.name)).toEqual(["studio", "phone"]);
    expect(machinesOf(view).map((entry) => entry.name)).toEqual(["studio"]);
  });

  test("a member with no kind is a machine, which is all a pre-kind index could hold", () => {
    expect(machinesOf(viewOf(member("studio"))).map((entry) => entry.name)).toEqual(["studio"]);
  });

  test("the witness set is the machines' signing keys", () => {
    const keys = machineKeysOf(viewOf(member("studio"), member("phone", "client")));
    expect([...keys]).toEqual(["sign-studio"]);
  });
});

describe("the format a file is written in", () => {
  test("a client in the index needs the new outer version, so a rolled-back host refuses the file", () => {
    expect(writeVersionOf({ members: [member("studio"), member("phone", "client")] })).toBe(CLIENT_FORMAT);
  });

  test("machines alone keep the version every reader already knows", () => {
    expect(writeVersionOf({ members: [member("studio")] })).not.toBe(CLIENT_FORMAT);
  });

  test("a file with no index yet is written in the old version", () => {
    expect(writeVersionOf(undefined)).not.toBe(CLIENT_FORMAT);
  });
});

describe("the readiness gate waits on machines, not on a client that can never answer", () => {
  test("a client in the roster does not keep the gate blocked once every machine has answered", () => {
    const view = viewOf(member("studio"), member("laptop"), member("phone", "client"));
    const answers = machinesOf(view)
      .filter((entry) => entry.name !== "studio")
      .map((entry) => ({ hostId: entry.signPub, reads: [2, 3] }));
    const roster = machinesOf(view)
      .map((entry) => entry.signPub)
      .filter((signPub) => signPub !== "sign-studio");
    expect(formatReadiness(roster, answers, 3)).toEqual({ kind: "ready" });
  });
});
