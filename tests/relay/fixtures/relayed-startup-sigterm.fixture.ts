import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { startRelayedHost } from "../support/relayed-host.ts";

// Not a *.test.ts: relayed-host.test.ts runs it with bun. It starts a relayed host, holds start-up once the part named
// by STAGE (relay, session or host) has started, says so, and goes on at the next line on stdin: the test sends SIGTERM
// in between, as an e2e helper can be stopped while it starts. How start-up ended is written to SETTLED_FILE.
const stage = process.env["STAGE"] ?? "";
const settledFile = process.env["SETTLED_FILE"] ?? "";
process.once("SIGTERM", () => process.stdout.write("SIGNALLED\n"));
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
try {
  await startRelayedHost("startup-sigterm", {
    started: async (part) => {
      if (!(stage in part)) return;
      process.stdout.write(`STAGE ${stage}\n`);
      await lines.next();
    },
  });
  writeFileSync(settledFile, "resolved");
} catch (error) {
  writeFileSync(settledFile, `rejected: ${String(error)}`);
}
