import { describe, expect, test } from "bun:test";
import { localKeyholder, serveKeyholder } from "@doriface/vault";
import { testDevice } from "../../../packages/vault/src/testing.ts";
import { vaultHandlers } from "../src/main/ipc-vault-handlers.ts";

const ORIGIN = "app://doriface";
const app = { senderFrame: { url: `${ORIGIN}/settings` } };
const foreign = { senderFrame: { url: "https://evil.example/" } };

async function rig() {
  const device = await testDevice();
  return {
    device,
    handlers: vaultHandlers({ origin: ORIGIN, serve: async () => serveKeyholder(localKeyholder(device.deviceKey)) }),
  };
}

describe("the vault keyholder over IPC", () => {
  test("answers the app's own page with handles, never a key", async () => {
    const { device, handlers } = await rig();
    expect(await handlers.keyholder(app, { op: "info" })).toEqual({
      recipient: device.deviceKey.recipient,
      protection: "non-extractable",
    });
    const created = await handlers.keyholder(app, { op: "generate", gen: 1 });
    expect(Object.keys(Object(created)).toSorted()).toEqual(["gen", "id", "publicKey"]);
    expect(JSON.stringify(created)).not.toContain("AGE-SECRET-KEY");
  });

  test("refuses another origin or a detached frame before touching the key", async () => {
    const { handlers } = await rig();
    await expect(handlers.keyholder(foreign, { op: "info" })).rejects.toThrow("refused IPC");
    await expect(handlers.keyholder({ senderFrame: null }, { op: "info" })).rejects.toThrow("refused IPC");
  });

  test("has no raw unseal: a request to open arbitrary ciphertext is refused", async () => {
    const { handlers } = await rig();
    await expect(handlers.keyholder(app, { op: "unseal", sealed: new Uint8Array(9) })).rejects.toThrow(
      "not a keyholder request",
    );
  });
});
