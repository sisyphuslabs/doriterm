import { describe, expect, test } from "bun:test";
import { HcRpcError } from "@doriface/protocol";
import { coreCompareAndSet } from "./core-doc.ts";

const DOC = "layout.host";

/**
 * A core's document as the e2e helper writes it: `doc.get` answers `{ value, version }`, `doc.set` is a compare-and-set at
 * the version it was given, and a stale version is refused the way the core refuses it.
 */
function fakeCore(initial: unknown) {
  let value = initial;
  let version = 1;
  const writes: unknown[] = [];
  const send = (method: string, params: unknown): unknown => {
    const asked = params as { readonly value?: unknown; readonly version?: number };
    if (method === "doc.get") return { value, version };
    if (method !== "doc.set") throw new Error(`unexpected ${method}`);
    if (asked.version !== version) throw conflict(version, asked.version);
    value = asked.value;
    version += 1;
    writes.push(asked.value);
    return { version };
  };
  return {
    send,
    writes,
    /** Another client writing between this helper's read and its set. */
    otherClient: (next: unknown) => {
      value = next;
      version += 1;
    },
    read: () => ({ value, version }),
  };
}

/** The core's refusal of a stale compare-and-set: its message, and its stable kind. */
const conflict = (at: number, asked: unknown): HcRpcError =>
  new HcRpcError({
    code: -32000,
    message: `${DOC} is at version ${at}, not ${String(asked)}`,
    data: { kind: "conflict" },
  });

const layout = (spaces: readonly unknown[]): Record<string, unknown> => ({ spaces });

describe("coreCompareAndSet (#896)", () => {
  test("hands the updater the document, not the doc.get reply", () => {
    const core = fakeCore(layout([{ id: "space-1", tabs: [{ id: "tab-1", name: "one" }] }]));
    const seen: unknown[] = [];
    coreCompareAndSet(core.send, { name: DOC }, (current) => {
      seen.push(current);
      return { ...(current as Record<string, unknown>), marks: ["renamed"] };
    });

    // The bug this covers: the updater was given `{ value, version }`, so a document derived from it wrote the reply back.
    expect(seen).toEqual([layout([{ id: "space-1", tabs: [{ id: "tab-1", name: "one" }] }])]);
    expect(core.read().value).toEqual({
      spaces: [{ id: "space-1", tabs: [{ id: "tab-1", name: "one" }] }],
      marks: ["renamed"],
    });
  });

  test("a write that lands in between is kept: the retry recomputes from the fresh document", () => {
    const core = fakeCore(layout([{ id: "space-1", tabs: [{ id: "tab-1", name: "one" }] }]));
    let raced = false;
    coreCompareAndSet(core.send, { name: DOC }, (current) => {
      const doc = current as { spaces: { tabs: { id: string; name: string }[] }[] };
      if (!raced) {
        raced = true;
        core.otherClient(
          layout([
            {
              id: "space-1",
              tabs: [
                { id: "tab-1", name: "renamed" },
                { id: "tab-2", name: "two" },
              ],
            },
          ]),
        );
      }
      return {
        ...doc,
        spaces: doc.spaces.map((space) =>
          Object.assign({}, space, { tabs: space.tabs.map((tab) => Object.assign({}, tab, { name: `${tab.name}!` })) }),
        ),
      };
    });

    expect(core.read().value).toEqual({
      spaces: [
        {
          id: "space-1",
          tabs: [
            { id: "tab-1", name: "renamed!" },
            { id: "tab-2", name: "two!" },
          ],
        },
      ],
    });
  });

  test("any other failure is thrown as it came, and not retried", () => {
    let sets = 0;
    const send = (method: string): unknown => {
      if (method === "doc.get") return { value: null, version: 1 };
      sets += 1;
      throw new Error("doc.set failed: the machine is offline");
    };
    expect(() => coreCompareAndSet(send, { name: DOC }, () => ({ kept: true }))).toThrow("the machine is offline");
    expect(sets).toBe(1);
  });

  test("a core that refuses every write: the fifth refusal is thrown, and there is no sixth attempt", () => {
    const refusals: HcRpcError[] = [];
    const send = (method: string): unknown => {
      if (method === "doc.get") return { value: null, version: refusals.length + 1 };
      const refusal = conflict(refusals.length + 2, refusals.length + 1);
      refusals.push(refusal);
      throw refusal;
    };
    let thrown: unknown;
    try {
      coreCompareAndSet(send, { name: DOC }, () => ({ kept: true }));
    } catch (cause) {
      thrown = cause;
    }
    expect(refusals).toHaveLength(5);
    expect(thrown).toBe(refusals[4]);
  });

  test("a failure that is not a conflict is not retried, even worded like one", () => {
    let sets = 0;
    const send = (method: string): unknown => {
      if (method === "doc.get") return { value: null, version: 1 };
      sets += 1;
      throw new HcRpcError({ code: -32603, message: `${DOC} is at version 2, not 1`, data: { kind: "internal" } });
    };
    expect(() => coreCompareAndSet(send, { name: DOC }, () => ({ kept: true }))).toThrow("is at version 2, not 1");
    expect(sets).toBe(1);
  });
});
