// Run with bun: adds the web e2e's second machine (a core with its own doriface-host) to the core this environment
// names, prints READY, and stops it all on SIGTERM. The desktop specs run under Node, so they start this rather than
// the Bun-only helper itself.
import { addMachine } from "./machine.ts";

const [root] = Bun.argv.slice(2);
if (root === undefined) throw new Error("usage: bun apps/web/e2e/added-machine.ts <scratch dir>");
const hc = process.env["HC_BIN"] || "hc";
const stop = await addMachine(hc, { ...process.env }, root, false, undefined, true);
process.once("SIGTERM", () => {
  void stop().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
});
console.log("READY");
