import { signCard } from "@doriface/mesh";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardBody } from "../state/mesh.ts";
import { deviceOf, machine, MeshFixture, noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { AuthorizeIndex, INDEX_RULES } from "./authorize-index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const member = (name: string, kind?: "machine" | "client") => ({
  signPub: `sign-${name}`,
  hostId: `host-${name}`,
  noisePub: `noise-${name}`,
  devicePub: `device-${name}`,
  name,
  hcId: `hc-${name}`,
  ...(kind === undefined ? {} : { kind }),
});

const indexOf = (members: readonly ReturnType<typeof member>[]): AuthorizeIndex =>
  new AuthorizeIndex({
    generation: 1,
    rules: INDEX_RULES,
    members: [...members],
    revoked: [],
    superseded: [],
    named: [],
  });

describe("a client member in the authorization index", () => {
  test("is found by its session key and never by the lookup a dialer uses", () => {
    const index = indexOf([member("phone", "client")]);
    expect(index.client("device-phone")?.name).toBe("phone");
    expect(index.member("device-phone")).toBeUndefined();
    expect(index.member("noise-phone")).toBeUndefined();
  });

  test("its session key is not refused as if it belonged to a machine", () => {
    const index = indexOf([member("phone", "client")]);
    expect(index.deviceRefusal("device-phone")).toBeUndefined();
  });

  test("a machine's device key is still refused, by name", () => {
    const index = indexOf([member("box", "machine")]);
    expect(index.deviceRefusal("device-box")).toBe("this key belongs to a mesh member: use the mesh line");
  });

  test("cleanup leaves a client's session key and hostId alone, so its push entry survives", () => {
    const index = indexOf([member("phone", "client"), member("box", "machine")]);
    const { keys, hostIds } = index.cleanup();
    expect(keys.has("device-phone")).toBe(false);
    expect(hostIds.has("host-phone")).toBe(false);
    expect(keys.has("device-box")).toBe(true);
    expect(hostIds.has("host-box")).toBe(true);
  });

  test("a client is counted as a member of the mesh with its signing key and core id known, though it never dials", () => {
    const index = indexOf([member("phone", "client"), member("box", "machine")]);
    expect(index.memberCount).toBe(2);
    expect(index.isMember("sign-phone")).toBe(true);
    expect(index.isMemberHcId("hc-phone")).toBe(true);
  });

  test("a member with no kind is a machine, which is all a pre-kind index could hold", () => {
    const index = indexOf([member("box")]);
    expect(index.member("noise-box")?.name).toBe("box");
    expect(index.client("noise-box")).toBeUndefined();
  });
});

describe("a revoked client is cleaned like any other member", () => {
  test("its session key is no longer a client's, so a paired entry holding it is removed", () => {
    const gone = member("old-phone", "client");
    const index = new AuthorizeIndex({
      generation: 1,
      rules: INDEX_RULES,
      members: [],
      revoked: [{ signPub: gone.signPub, hostId: gone.hostId, keys: [gone.noisePub, gone.devicePub] }],
      superseded: [],
      named: [],
    });
    expect(index.client(gone.devicePub)).toBeUndefined();
    expect(index.cleanup().keys.has(gone.devicePub)).toBe(true);
  });

  test("a machine's key stays in the cleanup even while a client's does not, so the roster still wins for machines", () => {
    const phone = member("phone", "client");
    const box = member("box");
    const index = new AuthorizeIndex({
      generation: 1,
      rules: INDEX_RULES,
      members: [phone, box],
      revoked: [],
      superseded: [],
      named: [],
    });
    const keys = index.cleanup().keys;
    expect(keys.has(phone.devicePub)).toBe(false);
    expect(keys.has(box.noisePub)).toBe(true);
  });
});

describe("a client admitted under a device key that is not its session key (design 4.1)", () => {
  test("is not indexed as a client, and the rest of the view still builds", () => {
    const dir = mkdtempSync(join(tmpdir(), "dh-client-binding-"));
    dirs.push(dir);
    const founder = machine("founder");
    const browser = machine("browser");
    const elsewhere = machine("elsewhere");
    const mesh = new MeshFixture(dir, founder);
    const card = signCard(
      cardBody(
        browser.identity,
        { name: browser.name, hcId: "", devicePub: deviceOf(elsewhere) },
        mesh.meshId,
        signPubOf(founder),
        undefined,
        "client",
      ),
      browser.identity.sign.secretKey,
    );
    mesh.record(founder, "admit", { card });
    expect(mesh.store.read()?.records).toHaveLength(2);
    const index = mesh.store.authorizeIndex();
    expect(index?.client(deviceOf(elsewhere))).toBeUndefined();
    expect(index?.isMember(signPubOf(browser))).toBe(false);
    expect(index?.member(noiseOf(founder))?.signPub).toBe(signPubOf(founder));
  });
});
