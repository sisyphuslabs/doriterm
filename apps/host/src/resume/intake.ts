/**
 * One OSC 7577 report from a terminal the host started, taken as the spec says: verified against that terminal's token
 * (an ignored report changes nothing), then checked against the OS (its pid runs, as this user, inside the terminal),
 * then kept as the terminal's record, or rejected, which removes what its owner left.
 */
import { verifyReport } from "./osc7577.ts";
import { descends, type FactsOf } from "./process-facts.ts";
import type { ResumeStore } from "./records.ts";

export interface IntakeDeps {
  readonly store: ResumeStore;
  readonly factsOf: FactsOf;
  readonly nowS: () => number;
  /** The host's own user: a record runs as it, so a report from another user's process is refused. */
  readonly uid: number;
  readonly log: (line: string) => void;
}

export type Intake = "ignored" | "rejected" | "cleared" | "accepted";

/** Takes one report body from terminal `address`, whose first process is `root` (undefined: not known). */
export async function takeReport(
  deps: IntakeDeps,
  address: string,
  root: number | undefined,
  body: Uint8Array,
): Promise<Intake> {
  const { store, log } = deps;
  const entry = store.entry(address);
  if (entry === undefined) return "ignored";
  const verdict = verifyReport(body, entry.token, deps.nowS(), (pid) => store.lastTime(address, pid));
  switch (verdict.kind) {
    case "ignored":
      return "ignored";
    case "rejected":
      if (verdict.pid !== undefined) store.reject(address, verdict.pid);
      log(`resume: ${address}: refused a report: ${verdict.why}`);
      return "rejected";
    case "clear":
      store.clear(address, verdict.pid, verdict.time);
      return "cleared";
    case "report": {
      const { pid } = verdict;
      const facts = await deps.factsOf(pid);
      let why: string | undefined;
      if (facts === undefined) why = "is not running";
      else if (facts.uid !== deps.uid) why = "runs as another user";
      else if (root === undefined || !(await descends(pid, root, deps.factsOf))) why = "is outside this terminal";
      if (facts === undefined || why !== undefined) {
        store.reject(address, pid);
        log(`resume: ${address}: refused a report: pid ${pid} ${why ?? "is not running"}`);
        return "rejected";
      }
      const kept = store.accept(address, {
        argv: verdict.argv,
        cwd: verdict.cwd ?? facts.cwd,
        cwdReported: verdict.cwd !== undefined,
        pid,
        started: facts.started,
        firstProcess: pid === root,
        time: verdict.time,
        uid: deps.uid,
      });
      if (kept === "accepted") return "accepted";
      log(`resume: ${address}: refused a report from pid ${pid}: ${kept === "full" ? "too many records" : "unknown"}`);
      return "rejected";
    }
  }
}
