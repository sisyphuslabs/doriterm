import { HcRpcError, type MachineView, type TerminalRunParams } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { failureNotice, startTerminal } from "./start-on.ts";

const refusing = (kind: string, message: string) => () =>
  Promise.reject(new HcRpcError({ code: -32000, message, data: { kind, hint: "" } }));

const run = (params: TerminalRunParams) => Promise.resolve({ address: `${params.on ?? "studio"}/t4` });
const local = { name: "studio", shown: () => [] };

test.each([
  ["needs_login", "build-box needs login"],
  ["connecting", "build-box is connecting"],
])("a refused New terminal follows the latest shown %s state (#2600 M1)", async (state, reason) => {
  const view: MachineView = {
    id: "id-build-box",
    name: "build-box",
    state: "connected",
    host: "build-box",
    target: "build-box",
    version: "0.1.21",
    since_ms: null,
    why: null,
  };
  let shown = [view];
  const reply = Promise.withResolvers<{ readonly address: string }>();
  const started = startTerminal(() => reply.promise, { on: view.name }, { name: "studio", shown: () => shown });
  shown = [{ ...view, state }];
  reply.reject(new HcRpcError({ code: -32000, message: "raw", data: { kind: "unavailable" } }));
  expect(await started).toEqual({
    ok: false,
    failure: { machine: view.name, kind: "unavailable", message: reason },
  });
});

describe("startTerminal on an added machine", () => {
  test("a started shell comes back with its machine-qualified address", async () => {
    expect(await startTerminal(run, { on: "build-box" }, local)).toEqual({ ok: true, address: "build-box/t4" });
  });

  test.each([
    ["unavailable", "build-box is offline"],
    ["machine_unknown", "build-box is no longer added here"],
  ])("terminal.run's %s refusal comes back as that kind, with advice naming the machine", async (kind, advice) => {
    const started = await startTerminal(refusing(kind, "raw"), { on: "build-box" }, local);
    if (started.ok) throw new Error("expected a refusal");
    expect([started.failure.kind, started.failure.machine]).toEqual([kind, "build-box"]);
    expect(started.failure.message).toBe(advice);
    expect(started.failure.message).not.toBe("raw");
  });

  test("another refusal keeps hc's own message", async () => {
    expect(await startTerminal(refusing("spawn_failed", "no shell"), { on: "build-box" }, local)).toEqual({
      ok: false,
      failure: { machine: "build-box", kind: "spawn_failed", message: "no shell" },
    });
  });
});

describe("startTerminal", () => {
  test("a run on this machine that fails comes back as a failure naming it, never as a rejection", async () => {
    const started = await startTerminal(() => Promise.reject(new Error("connection is closed")), {}, local);
    expect(started).toEqual({
      ok: false,
      failure: { machine: "studio", kind: "connection", message: "connection is closed" },
    });
  });

  test("a run on an added machine keeps the advice for that machine", async () => {
    const started = await startTerminal(refusing("unavailable", "raw"), { on: "build-box", cwd: "/w" }, local);
    if (started.ok) throw new Error("expected a refusal");
    expect(started.failure.message).toContain("build-box");
  });
});

describe("failureNotice", () => {
  const failure = { machine: "build-box", kind: "unavailable", message: "build-box is offline" };
  test("names the machine's own reason while connected", () => {
    expect(failureNotice(failure, false, "studio").description).toBe("build-box is offline");
  });
  test("names the reconnect while the link is down", () => {
    expect(failureNotice(failure, true, "studio").description).toBe(
      "Reconnecting to studio; try again once it is back.",
    );
  });
});
