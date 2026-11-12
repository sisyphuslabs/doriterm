// A spec's write to a herdr document on the e2e host's own core, the way another client would make it: read the
// version, then a compare-and-set at it, with the core environment the e2e host saved (E2E_HOST_ENV).
import { execFileSync } from "node:child_process";
import { HcRpcError, parseJsonRpc } from "@doriface/protocol";
import { E2E_HOST_ENV, E2E_LAYOUT_ENV } from "./config.ts";
import { readSavedEnv, type SavedEnv } from "./saved-env.ts";

interface CoreEnv extends SavedEnv {
  readonly session: string;
}

/** Which e2e core: the main host's, or the layout spec's (E2E_LAYOUT_ENV). */
export type Core = "host" | "layout";

function coreEnv(core: Core = "host"): CoreEnv {
  const file = core === "host" ? E2E_HOST_ENV : E2E_LAYOUT_ENV;
  const saved = readSavedEnv(file);
  const session = saved.env["HC_SESSION"];
  if (session === undefined) throw new Error(`${file} names no HC_SESSION`);
  return { ...saved, session };
}

function call(core: CoreEnv, method: string, params: unknown): unknown {
  const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`;
  const reply = execFileSync(core.hc, ["connect", "--session", core.session], {
    env: { ...process.env, ...core.env },
    input: request,
  }).toString();
  for (const line of reply.split("\n")) {
    const message: unknown = line.trim() === "" ? undefined : JSON.parse(line);
    if (typeof message === "object" && message !== null && "id" in message && message.id === 1) {
      if ("result" in message) return message.result;
      const failure = parseJsonRpc(line);
      if (failure.kind === "failure") {
        // The core's own error, so a caller can tell its kind (`data.kind`) from the wording.
        const error = new HcRpcError(failure.error);
        error.message = `${method} failed: ${error.message}`;
        throw error;
      }
      throw new Error(`${method} failed: ${line.slice(0, 300)}`);
    }
  }
  throw new Error(`${method}: no reply`);
}

/** An added machine's permanent core id, as the e2e host's core lists it (`machine.list`): the id a machine order names. */
export function machineCore(name: string): string {
  const listed = call(coreEnv(), "machine.list", {});
  const machines = typeof listed === "object" && listed !== null && "machines" in listed ? listed.machines : undefined;
  const found = Array.isArray(machines)
    ? machines.find(
        (machine: unknown) =>
          typeof machine === "object" && machine !== null && "name" in machine && machine.name === name,
      )
    : undefined;
  if (typeof found !== "object" || found === null || !("id" in found) || typeof found.id !== "string") {
    throw new Error(`machine.list names no machine ${name}`);
  }
  return found.id;
}

/** A document on the e2e host's own core as `doc.get` returns it. */
export function coreDoc(name: string): unknown {
  return call(coreEnv(), "doc.get", { name });
}

/**
 * Compare-and-set against the version the core reports, retrying a lost race on a fresh read: the app writes these documents
 * too, so a write can land between the read and its set and the core refuses it as a `conflict` (#896). Bounded in time
 * (CAS_BOUND_MS, growing pauses, #2409), and only for that refusal, told by its kind as the app tells it (#1355) -- any other failure is thrown as it came.
 *
 * `next` is called once per attempt with that attempt's read, so an update derived from the document is recomputed from the
 * document the core reports NOW instead of clobbering a write that landed in between.
 */
/**
 * How long a write keeps retrying a document another client is still writing (#2409). A page that has not settled can move
 * the document for a while after its test; five instant retries lost that race on a loaded runner. Pauses grow (25 ms,
 * doubling, at most 400 ms) so the other writer can finish, and a core that never accepts still fails within this bound.
 */
const CAS_BOUND_MS = 5_000;

/** A blocking pause: the helper is synchronous (execFileSync), as agents.ts and terminal-guard.ts wait. */
const REAL_WAIT: CasWait = {
  now: () => Date.now(),
  pause: (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
};

/** How the retry waits: the real clock and a blocking pause, or a clock a test moves. */
export interface CasWait {
  readonly now: () => number;
  readonly pause: (ms: number) => void;
}

export function coreCompareAndSet(
  send: (method: string, params: unknown) => unknown,
  where: Readonly<Record<string, unknown>>,
  next: (current: unknown) => unknown,
  wait?: CasWait,
): void {
  const clock = wait ?? REAL_WAIT;
  const deadline = clock.now() + CAS_BOUND_MS;
  for (let pause = 25; ; pause = Math.min(pause * 2, 400)) {
    const read = send("doc.get", where);
    const reply = typeof read === "object" && read !== null ? (read as Record<string, unknown>) : {};
    try {
      send("doc.set", {
        ...where,
        value: next("value" in reply ? reply["value"] : null),
        version: reply["version"] ?? 0,
      });
      return;
    } catch (cause) {
      if (!(cause instanceof HcRpcError && cause.kind === "conflict") || clock.now() + pause > deadline) throw cause;
    }
    clock.pause(pause);
  }
}

function writeCoreDoc(name: string, next: (current: unknown) => unknown, on: string | undefined, which: Core): void {
  const core = coreEnv(which);
  const where = on === undefined ? { name } : { name, on };
  coreCompareAndSet((method, params) => call(core, method, params), where, next);
}

/**
 * Makes a document BE `value` (a full literal, or `null` to delete it). A lost compare-and-set re-sends the same value at the
 * version the core reports then: a literal write states the test's own state, so the retry is that statement, not a merge.
 * Use {@link updateCoreDoc} when the value is derived from the document.
 */
export function setCoreDoc(name: string, value: unknown, on?: string, which: Core = "host"): void {
  writeCoreDoc(name, () => value, on, which);
}

/** Changes a document with a function of its current value, recomputed on every attempt (#896). */
export function updateCoreDoc(
  name: string,
  update: (current: unknown) => unknown,
  on?: string,
  which: Core = "host",
): void {
  writeCoreDoc(name, update, on, which);
}

/** A herdr document on the e2e host's core (or, with `on`, on its added machine), as another client would read it. */
export function getCoreDoc(name: string, on?: string): unknown {
  const current = call(coreEnv(), "doc.get", on === undefined ? { name } : { name, on });
  return typeof current === "object" && current !== null && "value" in current ? current.value : null;
}
