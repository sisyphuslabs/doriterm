import { describe, expect, test } from "bun:test";
import { INSTALL_SCRIPT_URL, joinCommand, offerFor } from "./join-command.ts";

describe("join command", () => {
  test("is one line: the installer, handed the link in its environment, quoted for sh", () => {
    expect(joinCommand("doriface://pair#h=a&k=b&m=1")).toBe(
      `curl -fsSL ${INSTALL_SCRIPT_URL} | DORIFACE_JOIN='doriface://pair#h=a&k=b&m=1' sh`,
    );
    // A quote in a link cannot end the value early.
    expect(joinCommand("x'y")).toBe(`curl -fsSL ${INSTALL_SCRIPT_URL} | DORIFACE_JOIN='x'\\''y' sh`);
  });

  test("keeps the link off every command line: no process is given it as an argument", () => {
    const command = joinCommand("doriface://pair#h=a&k=b&m=1");
    expect(command).not.toContain("--join");
    expect(command.split("|")[1]?.trim().endsWith(" sh")).toBe(true);
  });

  test("reads only the answer to this request", () => {
    expect(offerFor({ request: "r1" }, "r1")).toBeUndefined();
    expect(offerFor({ request: "r0", link: "doriface://pair#a", expiresAt: 5 }, "r1")).toBeUndefined();
    expect(offerFor({ request: "r1", link: "doriface://pair#a", expiresAt: 5 }, "r1")).toEqual({
      phase: "ready",
      link: "doriface://pair#a",
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
