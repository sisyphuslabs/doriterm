// The stand-in relay for the e2e app launches that are not pairing specs (#2399), in its own Bun process: the
// Playwright runner is Node, which can neither start a Bun.serve nor import the host's Bun-only test helpers.
//
//   bun e2e/host-rig.ts <host cli> <wrapper path> <record file>
//
// Writes the guard wrapper the app spawns as its host (the release relay replaced by this one), prints one JSON line
// ({ relay, hostCli, wrapper, records }) and stays up until its stdin closes or it is told to stop.
import { DEFAULT_RELAY_URL } from "@doriface/crypto";
import { FakeRelay } from "@doriface/host/testing";
import { writeHostWrapper } from "./host-wrapper.ts";

const [hostCli, wrapper, records] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (hostCli === undefined || wrapper === undefined || records === undefined) {
  console.error("usage: host-rig.ts <host cli> <wrapper path> <record file>");
  process.exit(2);
}

const relay = new FakeRelay();
if (relay.url === DEFAULT_RELAY_URL) {
  console.error(
    `host-rig: the stand-in relay is the release relay (${relay.url}); refusing to write the wrapper (#2399)`,
  );
  process.exit(2);
}
writeHostWrapper(wrapper, { standInRelay: relay.url, releaseRelay: DEFAULT_RELAY_URL, hostCli, recordFile: records });
console.log(JSON.stringify({ relay: relay.url, hostCli, wrapper, records }));

const done = Promise.withResolvers<void>();
process.once("SIGTERM", () => done.resolve());
process.once("SIGINT", () => done.resolve());
void Bun.stdin
  .stream()
  .getReader()
  .read()
  .then(() => done.resolve());
try {
  await done.promise;
} finally {
  await relay.stop();
}
process.exit(0);
