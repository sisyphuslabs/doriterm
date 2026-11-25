// Global teardown: every hc process still holding a file under this run's dir (see run-dir.ts) outlived the spec that
// started it, a launched app's local host or a scratch session whose dispose did not run. Stop them and fail the run
// naming them, as the host tests' guard does (#232, #470). Before that, the #2399 guard's own proof: once the run's
// rig engaged (its wrapper dir exists), records must exist and every recorded host must have started on this run's
// loopback stand-in - never the release relay. A run that never engaged the guard (an opt-out-only run) skips the
// check and only sweeps.
import { sweepRunDir } from "@doriface/host/testing/run-dir";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export default async function leftoverCores(): Promise<void> {
  const runDir = process.env["DORIFACE_E2E_RUN_DIR"];
  const failures: string[] = [];
  if (runDir !== undefined && runDir !== "" && existsSync(join(runDir, "host-wrapper"))) {
    const recordsFile = join(runDir, "host-wrapper", "records.jsonl");
    const lines =
      existsSync(recordsFile) && readFileSync(recordsFile, "utf8").trim() !== ""
        ? readFileSync(recordsFile, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line !== "")
        : [];
    if (lines.length === 0) {
      failures.push(
        "the desktop e2e run recorded no guarded launch: the guard engaged but no host went through the wrapper",
      );
    } else {
      const offenders = lines
        .map((line) => JSON.parse(line) as { readonly startedOn: string })
        .filter(({ startedOn }) => !/^https?:\/\/127\.0\.0\.1:\d+$/.test(startedOn));
      if (offenders.length > 0) {
        failures.push(
          `e2e launches started hosts outside this run's relay (the guard wrapper recorded them):\n  ${offenders
            .map((record) => JSON.stringify(record))
            .join("\n  ")}`,
        );
      }
    }
  }
  let outlived: readonly string[] = [];
  try {
    if (failures.length > 0) throw new Error(failures.join("\n"));
  } finally {
    outlived = await sweepRunDir();
  }
  if (outlived.length > 0) {
    const message = `hc processes outlived the desktop e2e run (now stopped):\n  ${outlived.join("\n  ")}`;
    throw new Error(failures.length > 0 ? `${failures.join("\n")}\n${message}` : message);
  }
}
