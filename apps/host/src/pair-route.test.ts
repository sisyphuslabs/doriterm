import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateX25519 } from "@doriface/crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "./auth.ts";
import { type Host, startHost } from "./host.ts";
import { DeviceStore } from "./state/devices.ts";
import { PairingStore } from "./state/pairing.ts";
import { createHcSession, type HcSession } from "./testing/hc-session.ts";

const token = generateToken();
let session: HcSession;
let host: Host;
let stateDir: string;

const pairUrl = (): string => `http://127.0.0.1:${host.port}/v1/pair`;
/** `null` sends no `Authorization` header at all; the default sends this host's token. */
const request = (method: "GET" | "POST" = "GET", auth: string | null = `Bearer ${token}`): Promise<Response> =>
  fetch(pairUrl(), { method, ...(auth === null ? {} : { headers: { authorization: auth } }) });

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "dh-pair-route-"));
  session = createHcSession("doriface-pair-route-test");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
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

describe("this computer's pairing offer on the loopback gateway", () => {
  test("a request without the host's token is refused", async () => {
    expect((await request("GET", null)).status).toBe(401);
    expect((await request("POST", "Bearer wrong-token-wrong-token-xxx")).status).toBe(401);
  });

  test("nothing opened reads as none", async () => {
    expect(await (await request()).json()).toEqual({ state: "none" });
  });

  test("opening answers the offer, and the state keeps answering it", async () => {
    const opened = await request("POST");
    expect(opened.status).toBe(200);
    const answer: unknown = await opened.json();
    if (typeof answer !== "object" || answer === null) throw new Error("the offer is not an object");
    expect(Reflect.get(answer, "state")).toBe("pending");
    const offer = Reflect.get(answer, "offer");
    if (typeof offer !== "object" || offer === null) throw new Error("no offer");
    const code: unknown = Reflect.get(offer, "code");
    if (typeof code !== "string") throw new Error("no code");
    expect(code).toHaveLength(8);
    expect(Reflect.get(offer, "opens")).toBe("desktop");
    expect(String(Reflect.get(offer, "link")).startsWith("doriface://pair#")).toBe(true);
    expect(String(Reflect.get(offer, "phoneLink")).startsWith("https://app.doriterm.com/pair#")).toBe(true);
    expect(Reflect.get(offer, "slot")).toBe("unavailable");
    expect(Reflect.get(offer, "codeUsable")).toBe(false);

    const state: unknown = await (await request()).json();
    if (typeof state !== "object" || state === null) throw new Error("the state is not an object");
    const current = Reflect.get(state, "offer");
    if (typeof current !== "object" || current === null) throw new Error("no current offer");
    expect(Reflect.get(current, "code")).toBe(code);
  });

  test("an offer a device used reads as paired, naming the device", async () => {
    const claim = new PairingStore(stateDir).claimLink();
    if ("refused" in claim) throw new Error(`claim refused: ${claim.reason}`);
    expect(claim.complete()).toBe(true);
    new DeviceStore(stateDir).add(generateX25519().publicKey, "phone");
    const answer: unknown = await (await request()).json();
    if (typeof answer !== "object" || answer === null) throw new Error("the state is not an object");
    expect(Reflect.get(answer, "state")).toBe("paired");
    const device = Reflect.get(answer, "device");
    if (typeof device !== "object" || device === null) throw new Error("no device");
    expect(Reflect.get(device, "name")).toBe("phone");
    expect(String(Reflect.get(device, "id"))).toMatch(/^[0-9A-F]{8}$/);
  });
});
