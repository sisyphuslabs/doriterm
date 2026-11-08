import { MESH_APPROVAL_DOC, type JsonValue } from "@doriface/protocol";
import { expect, test } from "bun:test";
import { answerMeshApproval } from "./approval-doc.ts";
import { PendingJoins } from "./pending-joins.ts";

test.each([undefined, "999 999", "123 456"])(
  "document approval with code %s reaches the real pending decision",
  async (code) => {
    const pending = new PendingJoins();
    const decision = pending.ask({
      nonce: "join",
      name: "browser",
      hostId: "host",
      noisePub: "noise",
      fingerprint: "fingerprint",
      kind: "client",
      expiresAt: Date.now() + 60_000,
      code: "123 456",
      joinerConfirmed: false,
    });
    pending.confirm("join");
    let value: JsonValue = { approve: "join", ...(code === undefined ? {} : { code }) };
    const store = {
      get: async () => ({ value, version: 1 }),
      set: async (name: string, next: JsonValue) => {
        expect(name).toBe(MESH_APPROVAL_DOC);
        value = next;
        return { version: 2 };
      },
    };
    await answerMeshApproval(store, (nonce, approve, shown) => pending.decide(nonce, approve, shown));
    if (code === "123 456") expect(await decision).toBe("approved");
    else {
      expect(pending.list()).toHaveLength(1);
      expect(value).toMatchObject({
        error: code === undefined ? "update this client to approve" : "the approval code does not match this join",
      });
      pending.decide("join", false);
      expect(await decision).toBe("denied");
    }
  },
);
