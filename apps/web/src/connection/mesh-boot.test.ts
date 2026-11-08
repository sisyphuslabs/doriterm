import { expect, test } from "bun:test";
import { HostStartError } from "../desktop/bridge.ts";
import { bootConnection } from "../desktop/local-host.ts";
import { MeshConnections } from "./mesh-connections.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { ConnectionStore } from "./store.ts";

test("a native boot failure reaches the mesh store without dialing the saved endpoint", async () => {
  let dials = 0;
  const mesh = new MeshConnections(
    { ...DEFAULT_SETTINGS, mode: "loopback", token: "saved" },
    (settings, save) =>
      new ConnectionStore(
        settings,
        async () => {
          dials += 1;
          throw new Error("the stale endpoint must not be dialed");
        },
        save,
      ),
  );
  const failure = { code: "hc-binary-missing", message: "missing", details: "missing" };
  try {
    await bootConnection({ startLocalHost: async () => Promise.reject(new HostStartError(failure)) }, mesh);
    expect(mesh.state).toEqual({ phase: "host-failed", failure });
    expect(dials).toBe(0);
  } finally {
    mesh.stop();
  }
});

test("connection-state notifications preserve the saved settings identity", () => {
  const mesh = new MeshConnections(
    { ...DEFAULT_SETTINGS, mode: "loopback", token: "saved" },
    (settings, save) => new ConnectionStore(settings, undefined, save),
  );
  try {
    const saved = mesh.settings;
    mesh.restoring();
    expect(mesh.settings).toBe(saved);
    expect(mesh.state.phase).toBe("connecting");
  } finally {
    mesh.stop();
  }
});
