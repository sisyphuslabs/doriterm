import { describe, expect, test } from "bun:test";
import { scopedSettings, shownSettings } from "./member-scope.ts";
import { DEFAULT_SETTINGS, type MemberTarget } from "./settings.ts";

const member = (hostId: string, keySlot?: string): MemberTarget => ({
  hostId,
  hostName: hostId,
  hostKey: `key-${hostId}`,
  directUrl: "",
  meshId: "mesh-2",
  ...(keySlot === undefined ? {} : { keySlot }),
});

describe("the mesh a member is dialled as (#2861)", () => {
  test("a learned member is dialled with the key slot its mesh knows this browser by", () => {
    expect(scopedSettings(DEFAULT_SETTINGS, member("b", "second"), true)).toMatchObject({
      hostId: "b",
      viewMember: true,
      keySlot: "second",
      meshId: "mesh-2",
    });
  });

  test("a paired member never inherits a slot or mesh, even one that reached the shared settings", () => {
    const leaked = { ...DEFAULT_SETTINGS, keySlot: "second", meshId: "mesh-2" };
    const paired = scopedSettings(leaked, member("a", "second"), false);
    expect(paired.keySlot).toBeUndefined();
    expect(paired.meshId).toBeUndefined();
    expect(shownSettings(leaked, member("a", "second"), false).keySlot).toBeUndefined();
  });
});
