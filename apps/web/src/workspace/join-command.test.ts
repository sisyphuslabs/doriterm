import { describe, expect, test } from "bun:test";
import { INSTALL_SCRIPT_URL, joinCommand, offerFor } from "./join-command.ts";

describe("join command", () => {
  test("is one line: the installer, told to join with the link, quoted for sh", () => {
    expect(joinCommand("doriface://pair#h=a&k=b&m=1")).toBe(
      `curl -fsSL ${INSTALL_SCRIPT_URL} | sh -s -- --join 'doriface://pair#h=a&k=b&m=1'`,
    );
    // A quote in a link cannot end the argument early.
    expect(joinCommand("x'y")).toBe(`curl -fsSL ${INSTALL_SCRIPT_URL} | sh -s -- --join 'x'\\''y'`);
  });

  test("reads only the answer to this request", () => {
    expect(offerFor({ request: "r1" }, "r1")).toBeUndefined();
    expect(offerFor({ request: "r0", link: "doriface://pair#a", expiresAt: 5 }, "r1")).toBeUndefined();
    expect(offerFor({ request: "r1", link: "doriface://pair#a", expiresAt: 5 }, "r1")).toEqual({
      phase: "ready",
      command: joinCommand("doriface://pair#a"),
      expiresAt: 5,
    });
    expect(offerFor({ request: "r1", error: "the mesh is full" }, "r1")).toEqual({
      phase: "failed",
      reason: "the mesh is full",
    });
    expect(offerFor({ request: "r1", expired: true }, "r1")).toEqual({ phase: "expired" });
    expect(offerFor({ request: "r1", joined: { name: "laptop", hostId: "h2" } }, "r1")).toEqual({
      phase: "joined",
      name: "laptop",
    });
    expect(offerFor(null, "r1")).toBeUndefined();
  });
});
