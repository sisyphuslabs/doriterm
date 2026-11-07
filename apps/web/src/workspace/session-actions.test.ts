import { describe, expect, test } from "bun:test";
import { HcRpcError } from "@doriface/protocol";
import { afterEnd, endLeftRunning, endSession, renameSession, type SessionCalls } from "./session-actions.ts";

type Call = { readonly method: string; readonly params: unknown };

/** The calls a session action makes, recorded; terminal.kill answers with a finished terminal. */
function recorder() {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (params: unknown): Promise<{ readonly state: "finished" }> => {
      calls.push({ method, params });
      return Promise.resolve({ state: "finished" });
    };
  const connection: SessionCalls = {
    label: record("terminal.label"),
    kill: record("terminal.kill"),
    rm: record("terminal.rm"),
  };
  return { calls, connection };
}

/** Calls whose `method` is refused with an hc error of this kind; the kill otherwise reports the program finished. */
function refusing(method: "kill" | "rm", kind: string): SessionCalls {
  const refuse = (): Promise<never> =>
    Promise.reject(new HcRpcError({ code: -32000, message: `${method}: ${kind}`, data: { kind } }));
  return {
    label: () => Promise.resolve({}),
    kill: method === "kill" ? refuse : () => Promise.resolve({ state: "finished" }),
    rm: method === "rm" ? refuse : () => Promise.resolve({}),
  };
}

describe("session actions", () => {
  test("a rename is the herdr.name label, and an empty name removes it (herdr-app label rules)", async () => {
    const { calls, connection } = recorder();
    await renameSession(connection, "t3", "  deploy  ");
    await renameSession(connection, "t3", "");
    expect(calls).toEqual([
      { method: "terminal.label", params: { terminal: "t3", labels: { "herdr.name": "deploy" } } },
      { method: "terminal.label", params: { terminal: "t3", labels: { "herdr.name": "" } } },
    ]);
  });

  test("ending marks the terminal for removal with the kill, then removes the finished terminal", async () => {
    const { calls, connection } = recorder();
    await endSession(connection, "box/t2");
    expect(calls).toEqual([
      { method: "terminal.label", params: { terminal: "box/t2", labels: { "herdr.end": "1" } } },
      { method: "terminal.kill", params: { terminal: "box/t2" } },
      { method: "terminal.rm", params: { terminal: "box/t2" } },
    ]);
  });

  test("a screen that leaves when the program exits waits for End's terminal.rm", async () => {
    const asked = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<unknown>();
    const connection: SessionCalls = {
      label: () => Promise.resolve({}),
      kill: () => Promise.resolve({ state: "finished" }),
      rm: () => {
        asked.resolve();
        return removed.promise;
      },
    };
    const left: string[] = [];
    const ending = endSession(connection, "t4");
    afterEnd("t4", () => left.push("t4"));
    afterEnd("t5", () => left.push("t5"));
    await asked.promise;
    // The program has exited and terminal.rm is out, unanswered: only the session with no End in flight has left.
    expect(left).toEqual(["t5"]);
    removed.resolve({});
    await ending;
    expect(left).toEqual(["t5", "t4"]);
  });

  test("an End whose kill is refused takes its mark back; one whose removal fails after the kill keeps it", async () => {
    const calls: { readonly method: string; readonly params: unknown }[] = [];
    const failing = (fails: "kill" | "rm"): SessionCalls => {
      const answer =
        (method: "label" | "kill" | "rm") =>
        (params: unknown): Promise<{ readonly state: "finished" }> => {
          calls.push({ method, params });
          return method === fails
            ? Promise.reject(new HcRpcError({ code: -32000, message: `${method}: busy`, data: { kind: "busy" } }))
            : Promise.resolve({ state: "finished" });
        };
      return { label: answer("label"), kill: answer("kill"), rm: answer("rm") };
    };
    await expect(endSession(failing("kill"), "t10")).rejects.toThrow("kill: busy");
    expect(calls.filter((call) => call.method === "label").map((call) => call.params)).toEqual([
      { terminal: "t10", labels: { "herdr.end": "1" } },
      { terminal: "t10", labels: { "herdr.end": "" } },
    ]);
    calls.length = 0;
    // The program was killed: the host still removes it, so the mark stays.
    await expect(endSession(failing("rm"), "t11")).rejects.toThrow("rm: busy");
    expect(calls.filter((call) => call.method === "label")).toHaveLength(1);
  });

  test("an End whose kill is refused left its program running; one whose removal fails after the kill did not", async () => {
    const killRefused: unknown = await endSession(refusing("kill", "busy"), "t12").catch((cause: unknown) => cause);
    expect(endLeftRunning(killRefused)).toBe(true);
    const rmRefused: unknown = await endSession(refusing("rm", "busy"), "t13").catch((cause: unknown) => cause);
    expect(endLeftRunning(rmRefused)).toBe(false);
    expect(endLeftRunning(new Error("another failure"))).toBe(false);
  });

  test("a terminal already gone when End's kill or rm lands counts as ended; any other refusal does not", async () => {
    await endSession(refusing("rm", "not_found"), "t8");
    await endSession(refusing("kill", "not_found"), "t8");
    await expect(endSession(refusing("rm", "busy"), "t9")).rejects.toThrow("rm: busy");
  });

  test("an earlier End of the same session settling does not release a screen waiting on a later one", async () => {
    const first = Promise.withResolvers<unknown>();
    const second = Promise.withResolvers<unknown>();
    const removals = [first, second];
    const connection: SessionCalls = {
      label: () => Promise.resolve({}),
      kill: () => Promise.resolve({ state: "finished" }),
      rm: () => removals.shift()?.promise ?? Promise.resolve({}),
    };
    const left: string[] = [];
    const earlier = endSession(connection, "t7");
    const later = endSession(connection, "t7");
    first.resolve({});
    await earlier;
    afterEnd("t7", () => left.push("t7"));
    expect(left).toEqual([]);
    second.resolve({});
    await later;
    expect(left).toEqual(["t7"]);
  });

  test("a failed End lets the screen leave, and the next exit of that session leaves at once", async () => {
    const connection: SessionCalls = {
      label: () => Promise.resolve({}),
      kill: () => Promise.reject(new Error("no such terminal")),
      rm: () => Promise.resolve({}),
    };
    const left: string[] = [];
    const ending = endSession(connection, "t6");
    afterEnd("t6", () => left.push("after-failure"));
    await expect(ending).rejects.toThrow("no such terminal");
    afterEnd("t6", () => left.push("later"));
    expect(left).toEqual(["after-failure", "later"]);
  });
});
