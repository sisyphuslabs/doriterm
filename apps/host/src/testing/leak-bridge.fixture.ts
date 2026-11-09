import { expect, test } from "bun:test";
import { bridge, hostIdFor } from "../mesh/testing/hc-mesh.ts";

test("finish after the bridge is connected, without awaiting its result", async () => {
  const stateDir = process.env["BRIDGE_STATE"];
  if (stateDir === undefined) throw new Error("BRIDGE_STATE required");
  void bridge("--mesh", "--state-dir", stateDir, hostIdFor("peer"));
  // The outer peer releases this only after the CLI has reached line.sock.
  const reader = Bun.stdin.stream().getReader();
  const ready = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(ready.value)).toBe("ready");
});
