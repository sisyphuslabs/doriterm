import { expect, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { attachedMachineName } from "./hello-name.ts";
import type { MemberTarget } from "./settings.ts";

const answering = (name: string) => ({ hello: { core: { id: "core-1", name } } }) as unknown as HcConnection;
const member = (hostId: string, hostName: string): MemberTarget => ({ hostId, hostName, hostKey: "k", directUrl: "" });
const roster = [member("host-a", "m942-a"), member("host-b", "m942-b")];

test("a joined browser names the machine it is attached to by its mesh member name, not its hc name (#1902)", () => {
  expect(
    attachedMachineName(
      answering("os-host"),
      { viewMember: true, hostId: "host-x", hostName: "", members: roster },
      "host-a",
    ),
  ).toBe("m942-a");
});

test("as a joined browser holds it: the attached member is its own hostId and mesh hostName, with no members (#1902)", () => {
  const joined = { viewMember: true, hostId: "host-a", hostName: "studio-mesh", members: [] };
  expect(attachedMachineName(answering("studio"), joined, "host-a")).toBe("studio-mesh");
});

test("after it re-attaches through another member, that member is named by its member name too (#1902)", () => {
  expect(
    attachedMachineName(
      answering("other-os-host"),
      { viewMember: true, hostId: "host-x", hostName: "", members: roster },
      "host-b",
    ),
  ).toBe("m942-b");
});

test("a paired host, which is no mesh member, keeps the name its hc answered with", () => {
  expect(
    attachedMachineName(answering("os-host"), { hostId: "host-a", hostName: "os-host", members: [] }, "host-a"),
  ).toBe("os-host");
});

test("a joined browser shown a member the roster does not hold, or one with no name yet, falls back to the hc name", () => {
  expect(
    attachedMachineName(
      answering("os-host"),
      { viewMember: true, hostId: "host-x", hostName: "", members: roster },
      "host-z",
    ),
  ).toBe("os-host");
  expect(
    attachedMachineName(
      answering("os-host"),
      { viewMember: true, hostId: "host-x", hostName: "", members: [member("host-a", "")] },
      "host-a",
    ),
  ).toBe("os-host");
  expect(
    attachedMachineName(
      answering("os-host"),
      { viewMember: true, hostId: "host-x", hostName: "", members: roster },
      undefined,
    ),
  ).toBe("os-host");
});
