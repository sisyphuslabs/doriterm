import { describe, expect, test } from "bun:test";
import { signCard, verifyCard } from "@doriface/mesh";
import { cardBody } from "../state/mesh.ts";
import { cardFor, deviceOf, machine, signPubOf } from "../testing/mesh-history.ts";

const a = machine("a");
const b = machine("b");
const own = { name: a.name, hcId: a.hcId, devicePub: deviceOf(a) };

describe("a card's member kind", () => {
  test("a version 1 card is a machine, because that is all the format ever meant", () => {
    const card = cardFor(a, "mesh-1", b);
    expect(verifyCard(card)?.kind).toBe("machine");
    expect(verifyCard(card)?.v).toBe(1);
  });

  test("a version 2 card names its kind", () => {
    const card = signCard(
      cardBody(a.identity, own, "mesh-1", signPubOf(b), undefined, "client"),
      a.identity.sign.secretKey,
    );
    const parsed = verifyCard(card);
    expect(parsed?.kind).toBe("client");
    expect(parsed?.v).toBe(2);
  });

  test("a version 2 client card without a session key is refused, because nothing could reach that member", () => {
    const card = signCard(
      cardBody(a.identity, { name: a.name, hcId: a.hcId }, "mesh-1", signPubOf(b), undefined, "client"),
      a.identity.sign.secretKey,
    );
    expect(verifyCard(card)).toBeUndefined();
  });

  test("a version 2 card that names no kind is refused rather than read as a machine", () => {
    const body = { ...cardFor(a, "mesh-1", b) };
    const raw = JSON.parse(body.body) as Record<string, unknown>;
    const withoutKind = signCard({ ...raw, v: 2 } as never, a.identity.sign.secretKey);
    expect(verifyCard(withoutKind)).toBeUndefined();
  });

  test("a version 2 card with an unknown kind is refused", () => {
    const raw = JSON.parse(cardFor(a, "mesh-1", b).body) as Record<string, unknown>;
    const bogus = signCard({ ...raw, v: 2, kind: "superuser" } as never, a.identity.sign.secretKey);
    expect(verifyCard(bogus)).toBeUndefined();
  });

  test("a version this build cannot read is refused", () => {
    const raw = JSON.parse(cardFor(a, "mesh-1", b).body) as Record<string, unknown>;
    const future = signCard({ ...raw, v: 3, kind: "client" } as never, a.identity.sign.secretKey);
    expect(verifyCard(future)).toBeUndefined();
  });
});
