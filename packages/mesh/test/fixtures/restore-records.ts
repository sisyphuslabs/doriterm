import { hashOf, signCard, signRecord } from "../../src/records/codec.ts";
import type { Signed } from "../../src/records/types.ts";
import { A, aB, B, cardBody, F, MESH, noise, nonce, signRaw } from "./door-set.ts";
import { keyOf, type TestKey } from "./signed.ts";

export const OLD = keyOf("old-phone");
export const OTHER = keyOf("other-browser");
export const FRESH = keyOf("new-phone");
export const CLONE = keyOf("second-phone");
export const AT = 1_795_747_200_000;

export const clientCard = (key: TestKey, inviter: string, keyNumber: number): Signed =>
  signCard(
    {
      ...cardBody(key, MESH, inviter, keyNumber, key.name),
      v: 2,
      kind: "client",
      devicePub: noise(keyNumber),
      hcId: "",
    },
    key.secret,
  );

const oldJoin = signRecord(
  {
    v: 2,
    mesh: MESH,
    type: "admit",
    by: A.pub,
    n: 3,
    prev: [hashOf(aB)],
    subject: { card: clientCard(OLD, A.pub, 3) },
  },
  A.secret,
);

const otherJoin = signRecord(
  {
    v: 2,
    mesh: MESH,
    type: "admit",
    by: A.pub,
    n: 4,
    prev: [hashOf(oldJoin)],
    subject: { card: clientCard(OTHER, A.pub, 4) },
  },
  A.secret,
);

export const SOLE = [F, aB, oldJoin];
export const WITH_OTHER = [...SOLE, otherJoin];

export interface RequestBody {
  readonly old: string;
  readonly signPub: string;
  readonly noise: string;
  readonly name: string;
  readonly nonce: string;
  readonly at: number;
}

export const requestBody = (fresh = FRESH): RequestBody => ({
  old: OLD.pub,
  signPub: fresh.pub,
  noise: noise(fresh === FRESH ? 5 : 6),
  name: fresh.name,
  nonce: nonce(fresh === FRESH ? 5 : 6),
  at: AT,
});

interface ReadmitFixture {
  readonly holder?: TestKey;
  readonly fresh?: TestKey;
  readonly from?: readonly Signed[];
  readonly approval?: TestKey;
  readonly attended?: boolean;
  readonly signedMesh?: string;
  readonly subject?: Partial<RequestBody>;
}

export function readmitFixture(options: ReadmitFixture = {}): Signed {
  const { holder = B, fresh = FRESH, from = SOLE, approval, attended = false, signedMesh = MESH, subject } = options;
  const body = requestBody(fresh);
  const request = JSON.stringify([signedMesh, body.old, body.signPub, body.noise, body.name, body.nonce, body.at]);
  const prev = from.at(-1);
  if (prev === undefined) throw new Error("fixture has no heads");
  const n = 1 + from.filter((r) => JSON.parse(r.body).by === holder.pub).length;
  return signRaw(
    JSON.stringify({
      v: 3,
      mesh: MESH,
      type: "readmit",
      by: holder.pub,
      n,
      prev: [hashOf(prev)],
      subject: {
        ...body,
        ...subject,
        newSig: signRaw(request, fresh, "doriterm readmit v1").sig,
        ...(attended ? {} : { oldSig: signRaw(request, OLD, "doriterm readmit v1").sig }),
        ...(approval === undefined
          ? {}
          : { approval: { by: approval.pub, sig: signRaw(request, approval, "doriterm approve readmit v1").sig } }),
      },
    }),
    holder,
  );
}
