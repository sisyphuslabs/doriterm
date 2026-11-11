import { existsSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { LocalRelay } from "../support/relay-dev.ts";
import { startRelayedHost } from "../support/relayed-host.ts";

// Not a *.test.ts: relayed-host.test.ts runs it with bun. It starts a relayed host, holds start-up once the part named
// by STAGE (relay, session or host) has started, says so, and goes on at the next line on stdin: the test sends SIGTERM
// in between, as an e2e helper can be stopped while it starts. How start-up ended is written to SETTLED_FILE.
// STAGE=uplink says so once the host has started and goes straight on into the uplink wait (HOST_RELAY_URL and UPLINK_MS
// point it at a relay that never answers). STAGE=teardown fails start-up once the host has started and holds that failed
// start's teardown at the host's stop, says so, and goes on at the next line on stdin (#2131). PAIR_CLI swaps in the
// pair CLI start-up runs last (#2155).
const stage = process.env["STAGE"] ?? "";
const settledFile = process.env["SETTLED_FILE"] ?? "";
const hostRelayUrl = process.env["HOST_RELAY_URL"];
const pairCli = process.env["PAIR_CLI"];
const uplinkTimeoutMs = process.env["UPLINK_MS"] === undefined ? undefined : Number(process.env["UPLINK_MS"]);
process.once("SIGTERM", () => process.stdout.write("SIGNALLED\n"));
// The pair step's watch, closed once start-up settles as well: an open watch keeps the fixture running too (#2268).
let pairWatch: { close(): void } | undefined;
if (stage === "pair") {
  // The stub pair CLI writes this file once it runs; that is when start-up is held at the pair step.
  const mark = process.env["PAIR_MARK"];
  // Without it the watch below would watch "." and the test would hang to its timeout instead of failing here (#2220).
  if (mark === undefined || mark === "")
    throw new Error("STAGE=pair needs PAIR_MARK, the file the stub pair CLI writes");
  const watcher = watch(dirname(mark), () => {
    if (!existsSync(mark)) return;
    watcher.close();
    pairWatch = undefined;
    process.stdout.write("STAGE pair\n");
  });
  pairWatch = watcher;
}
const stdinLines = createInterface({ input: process.stdin });
const lines = stdinLines[Symbol.asyncIterator]();
try {
  await startRelayedHost("startup-sigterm", {
    ...(hostRelayUrl === undefined ? {} : { hostRelayUrl }),
    ...(pairCli === undefined ? {} : { pairCli }),
    // STAGE=relay-start: a relay start that never finishes, held from the first step of start-up (#2220).
    ...(stage === "relay-start"
      ? {
          startRelay: () => {
            process.stdout.write("STAGE relay-start\n");
            return new Promise<never>(() => {});
          },
        }
      : {}),
    // STAGE=relay-fail: the relay start fails, so start-up fails before any hold and with no SIGTERM (#2268).
    ...(stage === "relay-fail"
      ? { startRelay: () => Promise.reject(new Error("the relay start failed on purpose")) }
      : {}),
    // STAGE=relay-late: a relay start that finishes on the SIGTERM itself, after start-up has seen the interrupt; the
    // relay it hands over records its stop in LATE_MARK (#2232). STAGE=relay-late-fail: the same, but that relay's stop
    // fails (#2239).
    ...(stage === "relay-late" || stage === "relay-late-fail"
      ? {
          startRelay: () => {
            process.stdout.write(`STAGE ${stage}\n`);
            const late: LocalRelay = {
              url: "http://127.0.0.1:9",
              output: () => "",
              stop: async () => {
                if (stage === "relay-late-fail") throw new Error("the late relay's stop failed on purpose");
                writeFileSync(process.env["LATE_MARK"] ?? "", "stopped");
              },
            };
            return new Promise<LocalRelay>((resolve) => process.once("SIGTERM", () => resolve(late)));
          },
        }
      : {}),
    ...(uplinkTimeoutMs === undefined ? {} : { uplinkTimeoutMs }),
    started: async (part) => {
      if (stage === "uplink") {
        if ("host" in part) process.stdout.write("STAGE uplink\n");
        return;
      }
      if (stage === "teardown") {
        if (!("host" in part)) return;
        const { host } = part;
        const stop = host.stop.bind(host);
        host.stop = async () => {
          process.stdout.write("STAGE teardown\n");
          await lines.next();
          return stop();
        };
        throw new Error("start-up failed on purpose");
      }
      if (!(stage in part)) return;
      process.stdout.write(`STAGE ${stage}\n`);
      await lines.next();
    },
  });
  writeFileSync(settledFile, "resolved");
} catch (error) {
  writeFileSync(settledFile, `rejected: ${String(error)}`);
  // On stderr too: a start-up that fails before its hold prints no STAGE line, and this is the only sign of why (#2268).
  console.error(`relayed-startup-sigterm: start-up rejected: ${String(error)}`);
}
// Nothing more is read or watched: without this the open stdin (or the pair step's watch) would keep the fixture running
// after a start-up that failed with no SIGTERM, and the test would wait to its timeout (#2268). Closing the reader is what
// lets it end; destroying stdin is not.
stdinLines.close();
pairWatch?.close();
