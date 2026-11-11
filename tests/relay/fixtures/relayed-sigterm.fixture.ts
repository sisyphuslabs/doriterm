import { startRelayedHost } from "../support/relayed-host.ts";

// Not a *.test.ts: relayed-host.test.ts runs it with bun. A relayed host in a process that leaves SIGTERM to the hooks
// startRelayedHost installs, as an e2e helper ends (web-relay-host.ts). It opens a terminal on the host's core, as a
// page's New tab does: a core with a terminal keeps running until it is told to stop. It prints READY, then waits.
const relayed = await startRelayedHost("sigterm-fixture");
const run = Bun.spawn([relayed.session.hc, "run", "--bg", "sh"], { env: relayed.session.env, stdout: "ignore" });
if ((await run.exited) !== 0) throw new Error("hc run --bg sh failed");
process.stdout.write("READY\n");
