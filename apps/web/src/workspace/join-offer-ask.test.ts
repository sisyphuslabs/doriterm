import { describe, expect, test } from "bun:test";
import { DEFAULT_PAIRING_WEB_ORIGIN } from "@doriface/crypto";
import { HcRpcError } from "@doriface/protocol";
import { askOnce, webInviteLink } from "./join-command.ts";

const conflict = (): HcRpcError =>
  new HcRpcError({ code: -32000, message: "document is at version 2, not 1", data: { kind: "conflict" } });

/** An offer document another writer keeps moving: the first `lost` writes are refused as conflicts. */
function documentWithRival(lost: number, failure: () => Error = conflict) {
  const state = { version: 1, reads: 0, writes: [] as number[], lost };
  return {
    state,
    calls: {
      get: async () => {
        state.reads += 1;
        return { value: null, version: state.version };
      },
      set: async (_value: { request: string }, version: number) => {
        state.writes.push(version);
        if (state.lost > 0) {
          state.lost -= 1;
          state.version += 1;
          throw failure();
        }
        state.version += 1;
        return { version: state.version };
      },
    },
  };
}

const REQUEST = { request: "r1" };
const open = () => false;

describe("asking for an offer while another writer moves the document (#2949 review)", () => {
  test("a write lost to another writer is written again at the version read after it", async () => {
    const { calls, state } = documentWithRival(1);
    await askOnce(calls as never, REQUEST, open);
    expect(state.writes).toEqual([1, 2]);
  });

  test("a failure that is no conflict is thrown at once, never written again", async () => {
    const { calls, state } = documentWithRival(1, () => new Error("doc.set failed"));
    await expect(askOnce(calls as never, REQUEST, open)).rejects.toThrow("doc.set failed");
    expect(state.writes).toEqual([1]);
  });

  test("it gives up after five lost writes and says why", async () => {
    const { calls, state } = documentWithRival(10);
    await expect(askOnce(calls as never, REQUEST, open)).rejects.toThrow("not 1");
    expect(state.writes).toHaveLength(5);
  });

  test("a request whose tab or dialog closed writes nothing more, so it never replaces the request after it", async () => {
    const { calls, state } = documentWithRival(1);
    let closed = false;
    const set = calls.set;
    calls.set = async (value, version) => {
      // The phone tab closes (the person picked Computer) while its first write is refused.
      closed = true;
      return set(value, version);
    };
    await askOnce(calls as never, REQUEST, () => closed);
    expect(state.writes).toEqual([1]);
    // The guard before the read: closed after the lost write, it reads nothing more.
    expect(state.reads).toBe(1);
  });

  test("a request whose tab closed while it read the version writes nothing at all", async () => {
    const { calls, state } = documentWithRival(0);
    let closed = false;
    const get = calls.get;
    calls.get = async () => {
      closed = true;
      return get();
    };
    await askOnce(calls as never, REQUEST, () => closed);
    expect(state.writes).toEqual([]);
  });
});

describe("the invite link a phone opens (#2939)", () => {
  const fragment = "doriface://pair#h=abc&m=1";

  test("is this app's own page when it is served over https", () => {
    expect(webInviteLink(fragment, "https://app.example.test")).toBe("https://app.example.test/pair#h=abc&m=1");
  });

  test("is the hosted app's page from the desktop app's scheme or a local http page", () => {
    for (const origin of ["app://doriface", "http://127.0.0.1:5173"]) {
      expect(webInviteLink(fragment, origin)).toBe(`${DEFAULT_PAIRING_WEB_ORIGIN}/pair#h=abc&m=1`);
    }
  });
});
