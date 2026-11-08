import { spawnSync } from "node:child_process";
import { HOST_BLOCK, PORT_TRY_LIMIT } from "./port-block.ts";
import { describePortFailure, listPortHolders, type TriedBlock } from "./port-holders.ts";

const NAMES = ["E2E_HOST_PORT", "E2E_WEB_PORT", "E2E_LAYOUT_PORT"] as const;

/** Set by the runner in this run's environment, and inherited by every web server, worker and spec: this run's own id. */
export const E2E_RUN_ID_ENV = "DORIFACE_E2E_RUN_ID";

// Binds port 0 for each, so the OS hands out ports no one holds, then releases them for this run's servers: a block of
// HOST_BLOCK consecutive free ports for the worker hosts, then one for the web server and one for the layout host
// (taken while the block is still held, so they never fall inside it). Prints them as JSON.
const PICK = `
const net = require("node:net");
const block = Number(process.env.E2E_HOST_BLOCK);
const limit = Number(process.env.E2E_PORT_TRIES);
const listen = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once("error", () => resolve(undefined));
  server.listen(port, "127.0.0.1", () => resolve(server));
});
(async () => {
  const tried = [];
  let held = [];
  for (let tries = 0; tries < limit && held.length === 0; tries++) {
    const first = await listen(0);
    if (first === undefined) continue;
    const base = first.address().port;
    const run = [first];
    let blocked = 0;
    for (let i = 1; i < block && base + i < 65536; i++) {
      const server = await listen(base + i);
      if (server === undefined) {
        blocked = base + i;
        break;
      }
      run.push(server);
    }
    if (run.length === block) held = run;
    else {
      tried.push({ base, blocked });
      for (const server of run) server.close();
    }
  }
  if (held.length === 0) {
    process.stdout.write(JSON.stringify({ tried: tried.slice(-10) }));
    process.exit(1);
  }
  const web = await listen(0);
  const layout = await listen(0);
  process.stdout.write(JSON.stringify({ host: held[0].address().port, web: web.address().port, layout: layout.address().port }));
  for (const server of [...held, web, layout]) server.close();
})();
`;

export const parseTried = (output: string): readonly TriedBlock[] => {
  try {
    const parsed: unknown = JSON.parse(output === "" ? "{}" : output);
    const tried = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "tried") : undefined;
    if (!Array.isArray(tried)) return [];
    return tried.flatMap((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return [];
      const base = Reflect.get(entry, "base");
      const blocked = Reflect.get(entry, "blocked");
      return typeof base === "number" && typeof blocked === "number" ? [{ base, blocked }] : [];
    });
  } catch {
    return [];
  }
};

/**
 * Gives this e2e run ports of its own (#37). e2e/config.ts calls it first, so in the runner process, which loads the
 * Playwright config, it sets them in the environment the web servers and workers inherit. A run given its ports
 * already (all three set) keeps them, and the workers and web servers find them set.
 */
/** The ports worth asking about: the base each attempt started from and the port that refused it, once each. */
export function portsToProbe(tried: readonly TriedBlock[]): readonly number[] {
  return [...new Set(tried.flatMap(({ base, blocked }) => [base, blocked]).filter((port) => port > 0))];
}

export function ensureRunPorts(): void {
  // Before the ports, and never regenerated: a host records the run that started it, so a run stops its own hosts and
  // leaves another run's alone (#1412).
  process.env[E2E_RUN_ID_ENV] ??= crypto.randomUUID();
  if (NAMES.every((name) => process.env[name] !== undefined)) return;
  const picked = spawnSync(process.execPath, ["-e", PICK], {
    env: { ...process.env, E2E_HOST_BLOCK: String(HOST_BLOCK), E2E_PORT_TRIES: String(PORT_TRY_LIMIT) },
    encoding: "utf8",
  });
  if (picked.status !== 0) {
    const tried = parseTried(picked.stdout);
    throw new Error(
      `could not find free ports for this e2e run: ${describePortFailure(tried, listPortHolders(portsToProbe(tried)))}${picked.stderr === "" ? "" : ` (${picked.stderr})`}`,
    );
  }
  const ports = JSON.parse(picked.stdout) as { host: number; web: number; layout: number };
  process.env["E2E_HOST_PORT"] = String(ports.host);
  process.env["E2E_WEB_PORT"] = String(ports.web);
  process.env["E2E_LAYOUT_PORT"] = String(ports.layout);
}
