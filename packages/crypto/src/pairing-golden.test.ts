import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { clientFlight, type PairingSecret } from "./client-flight.ts";
import { cpaceGenerator, cpaceInitiate, cpaceRespond } from "./cpace.ts";
import { answerClientFlight, type HostPairingSecret, readClientFlight } from "./host-flight.ts";
import { hostIdentityFromSecrets, x25519FromSecret } from "./identity.ts";
import { codePairingInputs } from "./pairing-keys.ts";
import { rawStaticKey } from "./static-key.ts";
import { Transport } from "./transport.ts";

const golden: unknown = await Bun.file(join(import.meta.dir, "..", "vectors", "doriface-pairing-golden.json")).json();

function field(...path: readonly string[]): string {
  let value: unknown = golden;
  for (const key of path) {
    if (typeof value !== "object" || value === null || !(key in value)) throw new Error(`golden ${path.join(".")}`);
    value = Object.entries(value).find(([name]) => name === key)?.[1];
  }
  if (typeof value !== "string") throw new Error(`golden ${path.join(".")} is not a string`);
  return value;
}
const bytes = (...path: readonly string[]): Uint8Array => Uint8Array.fromHex(field(...path));

const host = hostIdentityFromSecrets(bytes("hostSignSecret"), bytes("hostNoiseSecret"));
const device = x25519FromSecret(bytes("deviceSecret"));
const code = field("code");
const linkSecret = bytes("linkSecret");
const sid = bytes("sid");
const ya = BigInt(`0x${field("ya")}`);
const yb = BigInt(`0x${field("yb")}`);
const lanUrls = ["ws://192.0.2.10:7766/v1/e2ee"];

const cases: readonly (readonly [string, PairingSecret | undefined, HostPairingSecret | undefined])[] = [
  ["session", undefined, undefined],
  ["pairCode", { mode: "code", code, name: "phone" }, { mode: "code", code }],
  ["pairLink", { mode: "link", linkSecret, name: "phone" }, { mode: "link", linkSecret }],
];

describe("Doriterm v1.3 golden flights (fixed keys, ephemerals, CPace scalars and sid)", () => {
  test("the typed-code CPace inputs and shares match an independent CPace computation", () => {
    const inputs = { ...codePairingInputs(code, host.hostId, host.noise.publicKey), sid };
    expect(inputs.ci.toHex()).toBe(field("cpace", "ci"));
    expect(cpaceGenerator(inputs.prs, inputs.ci, sid).toBytes().toHex()).toBe(field("cpace", "generator"));
    const initiator = cpaceInitiate(inputs, { scalar: ya });
    const responder = cpaceRespond(inputs, initiator.share, { scalar: yb });
    expect([initiator.share.toHex(), responder.share.toHex()]).toEqual([field("cpace", "ya"), field("cpace", "yb")]);
    expect(responder.isk.toHex()).toBe(field("cpace", "isk"));
  });

  test.each(cases)("%s: flights 1, 2 and 3 and the handshake hash are pinned", async (label, pairing, secret) => {
    const flight = await clientFlight(
      {
        hostId: host.hostId,
        staticKey: rawStaticKey(device),
        remoteStatic: host.noise.publicKey,
        pairing,
        early: pairing === undefined ? new TextEncoder().encode("hello\n") : undefined,
      },
      { ephemeralSecret: bytes("clientEphemeral"), cpaceScalar: ya, sid },
    );
    const hostKey = rawStaticKey(host.noise);
    const randomness = { ephemeralSecret: bytes("hostEphemeral"), cpaceScalar: yb };
    const read = await readClientFlight(flight.first, host.hostId, hostKey, randomness);
    const reply = await answerClientFlight(read, host.hostId, hostKey, secret, lanUrls, randomness);
    const { handshake } = await flight.reply(reply);
    const done = handshake.finish();
    const [confirm] = new Transport(done.send, done.receive).seal(new Uint8Array(0));
    expect(flight.first.toHex()).toBe(field(label, "flight1"));
    expect(reply.toHex()).toBe(field(label, "flight2"));
    expect(confirm?.toHex()).toBe(field(label, "flight3"));
    expect(done.handshakeHash.toHex()).toBe(field(label, "handshakeHash"));
  });
});
