import { describe, expect, test } from "bun:test";
import { isMeshName, meshRevokeCommand } from "./mesh-name.ts";

describe("mesh names", () => {
  test.each(["laptop", "build-box", "t", "t0", "tx", "a.b_c-1", "x".repeat(32)])("herdr allows %s", (name) => {
    expect(isMeshName(name)).toBe(true);
  });

  test.each(["", "Laptop", "-lead", "build box", "t7", "t1b", "x".repeat(33), "a;b"])("herdr refuses %p", (name) => {
    expect(isMeshName(name)).toBe(false);
  });

  test("the revoke command is built here from a name herdr allows, and from nothing else", () => {
    expect(meshRevokeCommand("laptop")).toBe("doriface-host mesh revoke laptop");
    expect(meshRevokeCommand("x; rm -rf ~")).toBeUndefined();
  });
});
