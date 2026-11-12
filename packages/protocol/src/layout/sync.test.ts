import { describe, expect, test } from "bun:test";
import { isJsonObject, type JsonObject, type JsonValue } from "../json.ts";
import { HcRpcError } from "../jsonrpc.ts";
import { LayoutDoc, type DocCalls, type DocState } from "./sync.ts";

/** A core's document store with compare-and-set, and a way for "another client" to write between our calls. */
function store(initial: JsonValue) {
  let value = initial;
  let version = initial === null ? 0 : 1;
  const writes: JsonValue[] = [];
  const attempts: number[] = [];
  let before: (() => void) | undefined;
  let after: (() => void) | undefined;
  const calls: DocCalls = {
    get: async () => ({ value, version }),
    set: async (_on, next, at) => {
      attempts.push(at);
      before?.();
      before = undefined;
      if (at !== version) throw new HcRpcError({ code: -32000, message: "conflict", data: { kind: "conflict" } });
      value = next;
      version += 1;
      writes.push(next);
      const written = version;
      after?.();
      after = undefined;
      return { version: written };
    },
  };
  return {
    calls,
    writes,
    /** The version each compare-and-set was made at, in order. */
    attempts,
    /** Runs once right after our next write lands and before its reply reaches us. */
    afterOurs: (run: () => void) => {
      after = run;
    },
    current: () => value,
    other: (next: JsonValue) => {
      before = () => {
        value = next;
        version += 1;
      };
    },
    write: (next: JsonValue): number => {
      value = next;
      version += 1;
      return version;
    },
  };
}

const named = (doc: JsonObject | null, name: string): JsonObject => ({ ...doc, [name]: true });
const onlyWithTarget = (current: JsonObject | null): JsonObject | null =>
  isJsonObject(current) && current["target"] === true ? named(current, "mine") : null;
const unlessTheirs = (current: JsonObject | null): JsonObject | null =>
  current?.["theirs"] === true ? null : named(current, "mine");

async function ready(calls: DocCalls): Promise<{ doc: LayoutDoc; states: DocState[] }> {
  const states: DocState[] = [];
  const doc = new LayoutDoc(calls, null, (state) => states.push(state));
  await doc.refresh();
  return { doc, states };
}

describe("the layout document sync", () => {
  test("writes an edit at the version it read", async () => {
    const core = store({ spaces: [] });
    const { doc } = await ready(core.calls);
    expect(await doc.edit((current) => named(current, "mine"))).toBe(true);
    expect(core.current()).toEqual({ spaces: [], mine: true });
  });

  test("after a conflict it reads the other client's document and makes the edit again on it", async () => {
    const core = store({ spaces: [] });
    const { doc } = await ready(core.calls);
    core.other({ spaces: [], theirs: true });
    expect(await doc.edit((current) => named(current, "mine"))).toBe(true);
    expect(core.current()).toEqual({ spaces: [], theirs: true, mine: true });
  });

  test("another client's write between our read and our edit fails our compare-and-set at the version we read, and both edits stay", async () => {
    const core = store({ spaces: [] });
    const { doc } = await ready(core.calls);
    core.write({ spaces: [], theirs: true });
    expect(await doc.edit((current) => named(current, "mine"))).toBe(true);
    expect(core.attempts).toEqual([1, 2]);
    expect(core.current()).toEqual({ spaces: [], theirs: true, mine: true });
  });

  test("a doc event that arrives while our write is in flight is read once the write is done", async () => {
    const core = store({ spaces: [] });
    const { doc } = await ready(core.calls);
    core.afterOurs(() => {
      void doc.heard(core.write({ spaces: [], mine: true, theirs: true }));
    });
    expect(await doc.edit((current) => named(current, "mine"))).toBe(true);
    expect(doc.state).toEqual({ phase: "ready", doc: { spaces: [], mine: true, theirs: true }, version: 3 });
  });

  test("drops an edit that no longer applies to the other client's document", async () => {
    const core = store({ spaces: [], target: true });
    const { doc } = await ready(core.calls);
    core.other({ spaces: [] });
    expect(await doc.edit(onlyWithTarget)).toBe(false);
    expect(core.current()).toEqual({ spaces: [] });
    expect(doc.state).toEqual({ phase: "ready", doc: { spaces: [] }, version: 2 });
  });

  test("an edit shown once saved is on screen only as the host took it, and one that loses shows only the winner's document (#1572)", async () => {
    const core = store({ spaces: [] });
    const { doc, states } = await ready(core.calls);
    let shown = states.length;
    expect(await doc.edit(unlessTheirs, "once saved")).toBe(true);
    expect(states.slice(shown)).toEqual([{ phase: "ready", doc: { spaces: [], mine: true }, version: 2 }]);

    shown = states.length;
    core.other({ spaces: [], theirs: true });
    expect(await doc.edit(unlessTheirs, "once saved")).toBe(false);
    expect(states.slice(shown)).toEqual([{ phase: "ready", doc: { spaces: [], theirs: true }, version: 3 }]);
  });

  test("never writes a document it cannot read in full", async () => {
    const core = store({ spaces: [{ tabs: [{ root: { type: "grid" } }] }] });
    const { doc } = await ready(core.calls);
    expect(doc.state.phase).toBe("unreadable");
    await expect(doc.edit((current) => named(current, "mine"))).rejects.toThrow("cannot take changes now");
    expect(core.writes).toEqual([]);
  });

  test("an edit another client beats on every retry rejects, so it is never mistaken for one that no longer applies", async () => {
    let version = 1;
    const calls: DocCalls = {
      get: async () => ({ value: { spaces: [] }, version }),
      set: async () => {
        version += 1;
        throw new HcRpcError({ code: -32000, message: "conflict", data: { kind: "conflict" } });
      },
    };
    const { doc } = await ready(calls);
    await expect(doc.edit((current) => named(current, "mine"))).rejects.toThrow("kept changing");
  });

  test("a write the link drops under rejects with its own cause, not the re-read the closed link refuses (#698)", async () => {
    let up = true;
    const calls: DocCalls = {
      get: async () => {
        if (!up) throw new Error("connection is closed");
        return { value: { spaces: [] }, version: 1 };
      },
      set: async () => {
        up = false;
        throw new Error("link closed");
      },
    };
    const { doc } = await ready(calls);
    await expect(doc.edit((current) => named(current, "mine"))).rejects.toThrow("link closed");
    // The unsaved edit is not left on screen as if it were the document.
    expect(doc.state).toEqual({ phase: "unavailable", reason: "connection is closed" });
  });

  test("one re-read that fails does not leave the document unwritable for the next edit once the core answers again (#2436)", async () => {
    // A doc event's re-read hits a slow or dropped link once; the core answers again before the user's next edit.
    const core = store({ spaces: [] });
    let failNext = false;
    const calls: DocCalls = {
      get: (on) => {
        if (!failNext) return core.calls.get(on);
        failNext = false;
        return Promise.reject(new Error("doc.get timed out"));
      },
      set: core.calls.set,
    };
    const { doc } = await ready(calls);
    failNext = true;
    await doc.heard(core.write({ spaces: [], theirs: true }));
    expect(doc.state).toEqual({ phase: "unavailable", reason: "doc.get timed out" });
    await expect(doc.edit((current) => named(current, "mine"))).resolves.toBe(true);
    expect(core.writes).toEqual([{ spaces: [], theirs: true, mine: true }]);
  });

  test("a write while the document is unavailable whose re-read fails again rejects with that reason, and writes nothing (#2436)", async () => {
    const core = store({ spaces: [] });
    let down = false;
    const calls: DocCalls = {
      get: (on) => (down ? Promise.reject(new Error("doc.get timed out")) : core.calls.get(on)),
      set: core.calls.set,
    };
    const { doc } = await ready(calls);
    down = true;
    await doc.heard(core.write({ spaces: [], theirs: true }));
    const edit = doc.edit((current) => named(current, "mine"));
    await expect(edit).rejects.toThrow("The layout cannot take changes now: doc.get timed out");
    await expect(edit).rejects.toMatchObject({ kind: "unwritable", detail: "doc.get timed out" });
    expect(core.writes).toEqual([]);
  });

  test("a doc event for a version it did not write reads the document again", async () => {
    const core = store({ spaces: [] });
    const { doc, states } = await ready(core.calls);
    const version = core.write({ spaces: [], theirs: true });
    await doc.heard(version);
    expect(doc.state).toEqual({ phase: "ready", doc: { spaces: [], theirs: true }, version });
    const shown = states.length;
    await doc.heard(version);
    expect(states).toHaveLength(shown);
  });
});
