// Global teardown: every hc process still holding a file under this run's dir (see run-dir.ts) outlived the spec that
// started it, a launched app's local host or a scratch session whose dispose did not run. Stop them and fail the run
// naming them, as the host tests' guard does (#232, #470).
import { sweepRunDir } from "@doriface/host/testing/run-dir";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export default async function leftoverCores(): Promise<void> {
  // The #2399 guard's own proof, read before the sweep deletes the run dir: every host this run's launches started
  // (the guard wrapper records each one) started on this run's stand-in relay, on loopback - never the release relay.
  const runDir = process.env["DORIFACE_E2E_RUN_DIR"];
  if (runDir !== undefined && runDir !== "") {
    const records = join(runDir, "host-wrapper", "records.jsonl");
    if (existsSync(records)) {
      const offenders = readFileSync(records, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { readonly startedOn: string })
        .filter(({ startedOn }) => !/^https?:\/\/127\.0\.0\.1:\d+$/.test(startedOn));
      if (offenders.length > 0) {
        throw new Error(
          `e2e launches started hosts outside this run's relay (the guard wrapper recorded them):\n  ${offenders
            .map((record) => JSON.stringify(record))
            .join("\n  ")}`,
        );
      }
    }
  }
  const left = await sweepRunDir();
  if (left.length > 0)
    throw new Error(`hc processes outlived the desktop e2e run (now stopped):\n  ${left.join("\n  ")}`);
}
