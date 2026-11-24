import { describe, expect, test } from "bun:test";
import { vaultHandlers } from "../src/main/ipc-vault-handlers.ts";

const ORIGIN = "app://doriface";
const app = { senderFrame: { url: `${ORIGIN}/settings` } };
const foreign = { senderFrame: { url: "https://evil.example/" } };
const opened = new Uint8Array([1, 2, 3]);

const handlers = vaultHandlers({
  origin: ORIGIN,
  key: async () => ({ recipient: "age1test", protection: "os-keystore", unseal: async () => opened }),
});

describe("the vault key over IPC", () => {
  test("answers the app's own page", async () => {
    expect(await handlers.recipient(app)).toBe("age1test");
    expect(await handlers.protection(app)).toBe("os-keystore");
    expect(await handlers.unseal(app, new Uint8Array([9]))).toEqual(opened);
  });

  test("refuses another origin or a detached frame before touching the key", async () => {
    await expect(handlers.unseal(foreign, new Uint8Array([9]))).rejects.toThrow("refused IPC");
    await expect(handlers.recipient({ senderFrame: null })).rejects.toThrow("refused IPC");
  });

  test("refuses what cannot be a sealed wrap", async () => {
    await expect(handlers.unseal(app, "AGE")).rejects.toThrow("not a sealed vault wrap");
    await expect(handlers.unseal(app, new Uint8Array(65 * 1024))).rejects.toThrow("not a sealed vault wrap");
  });
});
