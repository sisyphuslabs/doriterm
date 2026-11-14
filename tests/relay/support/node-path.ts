// The harness's spawns and the relay:dev/relay:test command line share one shim filter, defined in the self-contained script.
export { relaySpawnEnv, withoutBunNodeShim } from "../private-relay.ts";
