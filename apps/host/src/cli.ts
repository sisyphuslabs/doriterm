#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { DEFAULT_RELAY_URL } from "@doriface/crypto";
import { assertValidToken, generateToken } from "./auth.ts";
import { CONNECT_USAGE, connectCommand } from "./commands/connect.ts";
import { DEVICES_USAGE, devicesCommand } from "./commands/devices.ts";
import { FINGERPRINT_USAGE, fingerprintCommand } from "./commands/fingerprint.ts";
import { MESH_JOIN_USAGE, meshJoinCommand } from "./commands/mesh-join.ts";
import { MESH_USAGE, meshCommand } from "./commands/mesh.ts";
import { PAIR_USAGE, pairCommand } from "./commands/pair.ts";
import { HOST_VERSION, startHost } from "./host.ts";
import { parseListen } from "./listen.ts";
import { defaultStateDir } from "./state/files.ts";

const USAGE = `usage: doriface-host [options]
       doriface-host pair [options]
       doriface-host devices list|revoke <id>
       doriface-host fingerprint
       doriface-host connect <hostId | pairing link | code>
       doriface-host mesh pair | mesh join <mesh link | code>
       doriface-host mesh status [--json]

  --listen <host:port>  where to listen (default 127.0.0.1:7766; loopback only)
  --hc <path>           the herdr-core binary (default hc)
  --session <name>      the hc session to reach (hc connect --session)
  --token <token>       the client token (default $DORIFACE_HOST_TOKEN, else 32 random bytes)
  --print-token         print the token on stdout once listening
  --unsafe-listen       allow a non-loopback --listen (plaintext: anyone who can reach it gets a shell)
  --lan-listen <h:p>    also serve the end-to-end encrypted /v1/e2ee (only) here; any address is fine
  --state-dir <dir>     host keys and paired devices (default $DORIFACE_HOST_STATE_DIR, else $XDG_STATE_HOME/doriface-host)
  --relay <url>         the relay this host keeps an encrypted-only uplink to (default ${DEFAULT_RELAY_URL})
  --no-relay            keep no relay uplink: reach this host only directly
  -h, --help            show this help`;

const log = (line: string): void => {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
};

const out = (text: string): void => {
  process.stdout.write(text);
};

async function main(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "pair") return pairCommand(rest, out);
  if (command === "fingerprint") return fingerprintCommand(rest, out);
  if (command === "connect") return connect(rest);
  if (command === "mesh" && rest[0] !== "status") {
    // Exits itself, as connect does: the relay socket a join opened would keep the process alive.
    await meshJoinCommand(rest, out, log);
    process.exit(0);
  }
  if (command === "devices") {
    process.exitCode = await devicesCommand(rest, out);
    return;
  }
  if (command === "mesh") {
    process.exitCode = await meshCommand(rest, out);
    return;
  }
  return serve(args);
}

const say = (line: string): void => {
  process.stderr.write(`doriface-host connect: ${line}\n`);
};

/** Exits itself: an open relay socket would keep the process alive, and hc reads only the last stderr line. */
async function connect(args: readonly string[]): Promise<void> {
  const code = await connectCommand(args, say).catch((error: unknown) => {
    say(error instanceof Error ? error.message : String(error));
    return 1;
  });
  process.exit(code);
}

async function serve(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      listen: { type: "string", default: "127.0.0.1:7766" },
      hc: { type: "string", default: "hc" },
      session: { type: "string" },
      token: { type: "string" },
      "print-token": { type: "boolean", default: false },
      "unsafe-listen": { type: "boolean", default: false },
      "lan-listen": { type: "string" },
      "state-dir": { type: "string" },
      relay: { type: "string", default: DEFAULT_RELAY_URL },
      "no-relay": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!URL.canParse(values.relay)) throw new Error(`--relay wants a URL, got ${JSON.stringify(values.relay)}`);
  const given = values.token ?? process.env["DORIFACE_HOST_TOKEN"] ?? "";
  const token = given === "" ? generateToken() : assertValidToken(given);
  const host = await startHost({
    listen: parseListen(values.listen),
    token,
    hc: values.hc,
    session: values.session,
    unsafeListen: values["unsafe-listen"],
    lanListen: values["lan-listen"] === undefined ? undefined : parseListen(values["lan-listen"], "--lan-listen"),
    stateDir: values["state-dir"] ?? defaultStateDir(),
    relay: values["no-relay"] ? undefined : { url: values.relay },
    log,
  });
  const session = values.session === undefined ? "" : `, session ${values.session}`;
  log(`doriface-host ${HOST_VERSION} listening on ${host.url} (hc ${host.hcVersion}${session})`);
  const e2ee = host.e2ee;
  if (e2ee !== undefined) {
    const lan = e2ee.lanUrls.length === 0 ? "" : ` and ${e2ee.lanUrls.join(", ")}`;
    log(`end-to-end encrypted at ${e2ee.url}${lan}; host ${e2ee.hostId}, fingerprint ${e2ee.fingerprint}`);
  }
  if (host.relayUrl !== undefined) log(`reachable through the relay ${host.relayUrl}`);
  if (values["print-token"]) process.stdout.write(`${token}\n`);
  else if (given === "") log("generated a token; pass --print-token to see it");

  const shutdown = (signal: string): void => {
    log(`${signal}: closing all pipes`);
    host.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        log(`shutdown failed: ${String(error)}`);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main(Bun.argv.slice(2)).catch((error: unknown) => {
  const usages: Readonly<Record<string, string>> = {
    pair: PAIR_USAGE,
    devices: DEVICES_USAGE,
    fingerprint: FINGERPRINT_USAGE,
    connect: CONNECT_USAGE,
    mesh: `${MESH_JOIN_USAGE}\n${MESH_USAGE}`,
  };
  const usage = usages[Bun.argv[2] ?? ""] ?? USAGE;
  process.stderr.write(`doriface-host: ${error instanceof Error ? error.message : String(error)}\n\n${usage}\n`);
  process.exit(2);
});
