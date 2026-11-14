import { expect, test } from "bun:test";
import { HcRpcError, type JsonValue, type MachineView } from "@doriface/protocol";
import { LayoutDoc } from "@doriface/protocol/layout";
import { graceViews, OFFLINE_GRACE_MS } from "./machine-grace.ts";
import { machineCause } from "./machine-cause.ts";
import { stateLabel } from "./machines.ts";
import { docCalls, docEdit, layoutsRestored, LAYOUT_LOADING, noEditsWhy } from "./use-layout-docs.ts";

const noChange = (): null => null;

test("a machine with no live document refuses an edit with why, instead of passing it off as one that no longer applies", async () => {
  await expect(docEdit(undefined)(noChange)).rejects.toThrow("the machine is offline");
  const changes: unknown[] = [];
  const live = { edit: (change: unknown) => (changes.push(change), Promise.resolve(true)) };
  expect(await docEdit(live)(noChange)).toBe(true);
  expect(changes).toEqual([noChange]);
});

const machine = (name: string, id = "permanent"): MachineView => ({
  host: "build",
  id,
  name,
  state: "connected",
  target: "build",
  version: "0.1.17",
});
const refused = (kind: string): HcRpcError => new HcRpcError({ code: -32000, message: kind, data: { kind } });

/** The host renames before this page hears it; its document and permanent id do not change. */
function renamedCore() {
  let name = "build-box";
  let value: JsonValue = null;
  let version = 0;
  const requests: { method: string; on: unknown }[] = [];
  const connection = {
    call: async (method: string, params?: Record<string, unknown>) => {
      requests.push({ method, on: params?.["on"] });
      if (method === "machine.list") return { machines: [machine("build-box", "someone-else"), machine(name)] };
      if (params?.["on"] !== name) throw refused("machine_unknown");
      if (method === "doc.get") return { value, version };
      if (params?.["version"] !== version) throw refused("conflict");
      value = params["value"] as JsonValue;
      version += 1;
      return { version };
    },
  };
  return {
    calls: docCalls(connection as never, () => [machine("build-box")]),
    requests,
    rename: () => {
      name = "build-renamed";
    },
    other: (next: JsonValue) => {
      value = next;
      version += 1;
    },
    current: () => value,
  };
}

test("a write refused before the rename feed arrives keeps the edit and retries by permanent machine id", async () => {
  const core = renamedCore();
  const doc = new LayoutDoc(core.calls, "permanent", () => {});
  await doc.refresh();
  core.rename();
  const edited = { spaces: [], mine: true };
  expect(await doc.edit(() => edited)).toBe(true);
  expect(core.current()).toEqual(edited);
  expect(doc.state).toEqual({ phase: "ready", doc: edited, version: 1 });
  expect(core.requests).toEqual([
    { method: "doc.get", on: "build-box" },
    { method: "doc.set", on: "build-box" },
    { method: "machine.list", on: undefined },
    { method: "doc.set", on: "build-renamed" },
  ]);
});

test("a read refused at the old name also finds the same machine's document", async () => {
  const core = renamedCore();
  core.rename();
  const doc = new LayoutDoc(core.calls, "permanent", () => {});
  await doc.refresh();
  expect(doc.state).toEqual({ phase: "ready", doc: null, version: 0 });
  expect(core.requests).toEqual([
    { method: "doc.get", on: "build-box" },
    { method: "machine.list", on: undefined },
    { method: "doc.get", on: "build-renamed" },
  ]);
});

test("an address already known from the feed is used without a failed call", async () => {
  const requests: unknown[] = [];
  let name = "build-box";
  const calls = docCalls(
    { call: async (_method: string, params: unknown) => (requests.push(params), { version: 1 }) } as never,
    () => [machine(name)],
  );
  name = "build-renamed";
  await calls.set("permanent", { spaces: [] }, 0);
  expect(requests).toEqual([{ name: "herdr-app", on: "build-renamed", value: { spaces: [] }, version: 0 }]);
});

test("a rename retry still rereads and reapplies the edit when another device wins the compare-and-set", async () => {
  const core = renamedCore();
  const doc = new LayoutDoc(core.calls, "permanent", () => {});
  await doc.refresh();
  core.rename();
  core.other({ spaces: [], theirs: true });
  expect(await doc.edit((current) => ({ ...current, mine: true }))).toBe(true);
  expect(core.current()).toEqual({ spaces: [], theirs: true, mine: true });
  expect(doc.state).toEqual({ phase: "ready", doc: { spaces: [], theirs: true, mine: true }, version: 2 });
});

test.each(["unavailable", "conflict", "machine_unknown"])(
  "a %s refusal with no rename is not retried",
  async (kind) => {
    const error = refused(kind);
    const requests: string[] = [];
    const calls = docCalls(
      {
        call: async (method: string) => {
          requests.push(method);
          if (method === "machine.list") return { machines: [machine("build-box")] };
          throw error;
        },
      } as never,
      () => [machine("build-box")],
    );
    await expect(calls.set("permanent", { spaces: [] }, 0)).rejects.toBe(error);
    expect(requests).toEqual(kind === "machine_unknown" ? ["doc.set", "machine.list"] : ["doc.set"]);
  },
);

const listed = (id: string, state: string): MachineView => ({ ...machine(id, id), state });

test.each([
  ["unreachable", "offline", "build-box is offline"],
  ["needs_login", "needs login", "build-box needs login"],
  ["connecting", "connecting", "build-box is connecting"],
])("a %s machine's edit reason names it with its row's %s state (#2595 L1)", (state, label, reason) => {
  const view = { ...machine("build-box"), state };
  expect(stateLabel(state)).toBe(label);
  expect(noEditsWhy(view.id, [view])).toBe(reason);
  expect(machineCause(view)?.title).toBe(reason);
});

test("a connected machine with no live document holds restoration until its layout answers (#2595 L2)", () => {
  const readOnly = noEditsWhy("m1", [listed("m1", "connected")]);
  expect(readOnly).toBe(LAYOUT_LOADING);
  expect(layoutsRestored(true, [{ loaded: false, readOnly }])).toBe(false);
  expect(layoutsRestored(true, [{ loaded: true, readOnly: null }])).toBe(true);
});

test("restoration waits for machine.list but not an unavailable machine's missing document (#2595 L2)", () => {
  const readOnly = noEditsWhy("m1", [listed("m1", "unreachable")]);
  expect(layoutsRestored(false, [{ loaded: false, readOnly }])).toBe(false);
  expect(layoutsRestored(true, [{ loaded: false, readOnly }])).toBe(true);
});

test("past the reconnect grace the edit reason agrees with the sidebar's offline state and notice (#2590)", () => {
  const dropped = listed("m1", "unreachable");
  const shown = graceViews([dropped], new Map([["m1", 1_000]]), 1_000 + OFFLINE_GRACE_MS);
  const view = shown[0];
  expect(view).toBeDefined();
  if (view === undefined) return;
  expect(stateLabel(view.state)).toBe("offline");
  expect(machineCause(view)?.title).toBe("m1 is offline");
  expect(noEditsWhy("m1", shown)).toBe("m1 is offline");
});

test("inside the reconnect grace the edit reason agrees with the sidebar and does not say offline (#2590)", () => {
  const shown = graceViews([listed("m1", "unreachable")], new Map([["m1", 1_000]]), 1_000 + OFFLINE_GRACE_MS - 1);
  expect(shown.map((view) => stateLabel(view.state))).toEqual(["reconnecting"]);
  expect(noEditsWhy("m1", shown)).toBe("m1 is reconnecting");
});

test("a machine held through a redial refuses its edits as its row reads it, reconnecting; a connected one waits for its layout (#918, #2595)", async () => {
  expect(noEditsWhy("m1", [listed("m1", "reconnecting")])).toBe("m1 is reconnecting");
  expect(noEditsWhy("m1", [listed("m1", "connected")])).toBe("the layout is loading");
  await expect(docEdit(undefined, noEditsWhy("m1", [listed("m1", "reconnecting")]))(noChange)).rejects.toThrow(
    "The layout cannot take changes now: m1 is reconnecting",
  );
});

test("a machine that reads offline, or is not listed, has the offline reason", () => {
  expect(noEditsWhy("m1", [listed("m1", "unreachable")])).toBe("m1 is offline");
  expect(noEditsWhy("m1", [])).toBe("the machine is offline");
});
