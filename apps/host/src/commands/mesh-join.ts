import {
  buildPairingUrl,
  DEFAULT_RELAY_URL,
  fingerprintOf,
  formatPairingCode,
  pairingWebOrigin,
  relayWebSocketUrl,
} from "@doriface/crypto";
import { parseArgs } from "node:util";
import { renderUnicodeCompact } from "uqr";
import { parseTarget } from "../connect/target.ts";
import { controlIsLive, requestControl } from "../control.ts";
import { readHcCore } from "../mesh/hc-core.ts";
import { joinMesh } from "../mesh/join-dial.ts";
import { openReadOnlyRelayPasses } from "../relay/relay-passes.ts";
import { defaultStateDir, isRecord } from "../state/files.ts";
import { loadHostIdentity } from "../state/host-keys.ts";
import { pendingFromWire } from "../state/pairing.ts";
import { DEFAULT_WEB_ORIGIN } from "./pair.ts";

export const MESH_JOIN_USAGE = `usage: doriface-host mesh pair [--auto] [--no-qr] [--web-origin <url>] [--relay <url>]
       doriface-host mesh join <mesh link | code> [--fingerprint <fp>] [--name <mesh name>] [--yes]

  mesh pair opens a single-use offer (10 minutes) for another machine to join this host's mesh. The running host
  serves the join and asks here before it admits the machine (--auto admits without asking, for scripts).
  mesh join joins the mesh of the member that printed the link or code. A typed code needs --fingerprint (at least
  its first 4 groups); --yes skips only a link's confirmation.

  --state-dir <dir>  the host's state (default $DORIFACE_HOST_STATE_DIR, else $XDG_STATE_HOME/doriface-host)
  --hc <path>        mesh join without a running host: the herdr-core binary (default hc)
  --session <name>   mesh join without a running host: the hc session this host serves`;

async function ask(question: string, out: (text: string) => void): Promise<boolean> {
  out(`${question} [y/N] `);
  for await (const line of console) return /^y(es)?$/i.test(line.trim());
  return false;
}

async function pair(args: readonly string[], out: (text: string) => void): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      auto: { type: "boolean", default: false },
      "no-qr": { type: "boolean", default: false },
      "web-origin": { type: "string", default: DEFAULT_WEB_ORIGIN },
      relay: { type: "string", default: DEFAULT_RELAY_URL },
      "state-dir": { type: "string" },
    },
  });
  relayWebSocketUrl(values.relay);
  pairingWebOrigin(values["web-origin"]);
  const stateDir = values["state-dir"] ?? defaultStateDir();
  const identity = loadHostIdentity(stateDir);
  const answer = await requestControl(stateDir, { op: "mesh-pair", auto: values.auto });
  if (answer === undefined) throw new Error("doriface-host is not running on this state dir: it serves the join");
  const offer = pendingFromWire(answer);
  const url = buildPairingUrl({
    webOrigin: values["web-origin"],
    hostId: identity.hostId,
    noiseStaticPub: identity.noise.publicKey,
    signPub: identity.sign.publicKey,
    linkSecret: offer.linkSecret,
    relayUrl: values.relay,
    mesh: true,
  });
  out(
    [
      "On the machine that joins, run: doriface-host mesh join '<this link>' (or the code with --fingerprint).",
      "It will reach every machine in the mesh, and so will every device paired to it.",
      "",
      ...(values["no-qr"] ? [] : [renderUnicodeCompact(url, { ecc: "L", border: 2 }), ""]),
      url,
      "",
      `code        ${formatPairingCode(offer.code)}`,
      `fingerprint ${fingerprintOf(identity.noise.publicKey)}`,
      `host        ${identity.hostId}`,
      `expires     ${new Date(offer.expiresAt).toISOString()}`,
      "",
    ].join("\n"),
  );
  if (values.auto) return;
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => expired.reject(new Error("the offer expired with no join")),
    offer.expiresAt - Date.now(),
  );
  const pending = await Promise.race([requestControl(stateDir, { op: "mesh-pending" }), expired.promise]).finally(() =>
    clearTimeout(timer),
  );
  if (!isRecord(pending) || typeof pending["nonce"] !== "string") throw new Error("the running host sent no join");
  const { nonce, name, hostId, fingerprint } = pending;
  const approve = await ask(`admit "${String(name)}" ${String(hostId)} fingerprint ${String(fingerprint)}?`, out);
  const decided = await requestControl(stateDir, { op: "mesh-approve", nonce, approve });
  const done = isRecord(decided) && decided["decided"] === true;
  out(done ? (approve ? "admitted\n" : "denied\n") : "the join expired or was decided elsewhere\n");
}

async function join(args: readonly string[], out: (text: string) => void, log: (line: string) => void): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: {
      fingerprint: { type: "string" },
      name: { type: "string" },
      yes: { type: "boolean", default: false },
      relay: { type: "string" },
      hc: { type: "string", default: "hc" },
      session: { type: "string" },
      "state-dir": { type: "string" },
    },
  });
  const [given] = positionals;
  if (given === undefined) throw new Error("mesh join needs a mesh pairing link or code");
  const target = parseTarget(given);
  const stateDir = values["state-dir"] ?? defaultStateDir();
  const question =
    target.kind === "link"
      ? `join the mesh of host ${target.link.hostId}, fingerprint ${fingerprintOf(target.link.noiseStaticPub)}?`
      : undefined;
  const yes = values.yes || (question !== undefined && (await ask(question, out)));
  const request = { target: given, fingerprint: values.fingerprint, name: values.name, relay: values.relay, yes };
  if (await controlIsLive(stateDir)) {
    const joined = await requestControl(stateDir, { op: "mesh-join", ...request });
    const meshId = isRecord(joined) ? joined["meshId"] : undefined;
    return out(`joined mesh ${String(meshId)}; the running host keeps the session for sync\n`);
  }
  const core = await readHcCore({ hc: values.hc, session: values.session });
  const identity = loadHostIdentity(stateDir);
  const joined = await joinMesh({
    stateDir,
    identity,
    target,
    fingerprint: values.fingerprint,
    name: values.name ?? core.name,
    hcId: core.id,
    yes,
    confirm: async () => false,
    relayUrl: values.relay,
    defaultRelayUrl: DEFAULT_RELAY_URL,
    proofs: await openReadOnlyRelayPasses(stateDir, identity, log),
    log,
  });
  joined.secure.close();
  out(`joined mesh ${joined.meshId}; start doriface-host to take part\n`);
}

export async function meshJoinCommand(
  args: readonly string[],
  out: (text: string) => void,
  log: (line: string) => void,
): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "pair") return pair(rest, out);
  if (sub === "join") return join(rest, out, log);
  throw new Error(`unknown mesh command ${JSON.stringify(sub ?? "")}`);
}
