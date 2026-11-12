import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateX25519 } from "@doriface/crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "./auth.ts";
import { DeviceSurface, UnknownDeviceError } from "./device-surface.ts";
import { type Host, startHost } from "./host.ts";
import { DeviceStore, deviceIdOf } from "./state/devices.ts";
import { createHcSession, type HcSession } from "./testing/hc-session.ts";

const token = generateToken();
/** The short id a device with this static key gets. */
const idOf = (key: Uint8Array): string =>
  deviceIdOf({ clientStaticPub: Buffer.from(key).toString("base64url"), name: "", pairedAt: "" });
let session: HcSession;
let host: Host;
let stateDir: string;

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "dh-device-route-"));
  session = createHcSession("doriface-device-route-test");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    // The LAN listener serves /healthz and /v1/e2ee only: the device routes must not appear on it.
    lanListen: { hostname: "127.0.0.1", port: 0 },
    token,
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir,
    log: () => {},
  });
});

afterAll(async () => {
  await host.stop();
  await session.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

const devicesUrl = (id?: string): string =>
  `http://127.0.0.1:${host.port}/v1/devices${id === undefined ? "" : `/${id}`}`;

/** `null` sends no `Authorization` header at all; the default sends this host's token. */
const request = (method: "GET" | "DELETE", id?: string, auth: string | null = `Bearer ${token}`): Promise<Response> =>
  fetch(devicesUrl(id), { method, ...(auth === null ? {} : { headers: { authorization: auth } }) });

describe("this computer's paired devices on the loopback gateway", () => {
  test("a request without the host's token is refused, for reading and for revoking", async () => {
    expect((await request("GET", undefined, null)).status).toBe(401);
    expect((await request("DELETE", "3FA94C0E", "Bearer wrong-token-wrong-token-xxx")).status).toBe(401);
  });

  test("a device the store holds is listed with the id a person can read out", async () => {
    const device = new DeviceStore(stateDir).add(generateX25519().publicKey, "phone");
    const answer: unknown = await (await request("GET")).json();
    expect(answer).toEqual({ devices: [{ name: "phone", id: deviceIdOf(device), pairedAt: device.pairedAt }] });
  });

  test("revoking answers what was revoked and leaves the store without it", async () => {
    const device = new DeviceStore(stateDir).list()[0];
    if (device === undefined) throw new Error("no device was paired");
    const answer: unknown = await (await request("DELETE", deviceIdOf(device))).json();
    expect(answer).toEqual({ revoked: [{ name: device.name, id: deviceIdOf(device), pairedAt: device.pairedAt }] });
    expect(new DeviceStore(stateDir).list()).toEqual([]);
  });

  test("an id no device has is refused as not found, naming the id", async () => {
    const short = "AB12CD34";
    const answer = await request("DELETE", short);
    expect(answer.status).toBe(404);
    expect(await answer.json()).toEqual({ error: `no paired device has the id ${JSON.stringify(short)}` });
  });

  test("the LAN listener does not serve the device routes, token or not", async () => {
    const lan = host.e2ee?.lanUrls[0];
    if (lan === undefined) throw new Error("the host started no LAN listener");
    const url = `${lan.replace(/^ws/, "http").replace(/\/v1\/e2ee$/, "")}/v1/devices`;
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
  });

  test("a short id two devices share is refused as a conflict, and neither is revoked", async () => {
    // Two keys whose short ids (the first eight hex characters of SHA-256(key)) collide, found once offline (a
    // collision needs tens of thousands of random draws, far too slow and uneven to search for in a test, #2418).
    const collision = [
      Buffer.from("XPW-XL7J3VKRSNbU4WPiliBR2WHMCFwqK6KLTqyFJ3o", "base64url"),
      Buffer.from("bzroR4h3wxk-YQ0-dRvdoqB8ORYjzWMbpf6V39GFUTo", "base64url"),
    ] as const;
    expect(idOf(collision[0])).toBe(idOf(collision[1]));
    const store = new DeviceStore(stateDir);
    store.add(collision[0], "first");
    store.add(collision[1], "second");
    const id = deviceIdOf(store.list()[0] ?? { clientStaticPub: "", name: "", pairedAt: "" });
    const answer = await request("DELETE", id);
    expect(answer.status).toBe(409);
    const body: unknown = await answer.json();
    expect(body).toEqual({
      error: `${id} matches 2 devices; revoke one from this computer's terminal by its full fingerprint`,
    });
    expect(store.list()).toHaveLength(2);
  });
});

describe("the device surface a revoke goes through", () => {
  test("a revoke runs the host's after-changes step once, and an unknown id runs none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dh-device-surface-"));
    try {
      const devices = new DeviceStore(dir);
      const phone = devices.add(generateX25519().publicKey, "phone");
      let changes = 0;
      const surface = new DeviceSurface({ devices, changed: async () => void (changes += 1) });
      expect(await surface.revoke(deviceIdOf(phone))).toHaveLength(1);
      expect(changes).toBe(1);
      await expect(surface.revoke(deviceIdOf(phone))).rejects.toBeInstanceOf(UnknownDeviceError);
      expect(changes).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
