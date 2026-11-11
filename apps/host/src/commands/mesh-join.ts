import {
  DEFAULT_RELAY_URL,
  fingerprintOf,
  formatPairingCode,
  pairingWebOrigin,
  relayWebSocketUrl,
} from "@doriface/crypto";
import { readFileSync } from "node:fs";
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
import { waitForHost, waitSeconds } from "./wait-host.ts";
import { pairingArtifact } from "../pair-link.ts";

export const MESH_JOIN_USAGE = `usage: doriface-host mesh pair [--auto] [--no-qr] [--web-origin <url>] [--relay <url>]
       doriface-host mesh join <mesh link | code> [--fingerprint <fp>] [--name <mesh name>] [--yes] [--wait-host <secs>]
       doriface-host mesh join --from-file <file> [options as above]

  mesh pair opens a single-use offer (10 minutes) for another machine to join this host's mesh. The running host
  serves the join and asks here before it admits the machine (--auto admits without asking, for scripts).
  mesh join compares a short code with the inviting machine. --yes trusts a one-line machine invite; it never
  answers a code question. --fingerprint adds a pin from another channel on every kind of invite.

  --state-dir <dir>  the host's state (default $DORIFACE_HOST_STATE_DIR, else $XDG_STATE_HOME/doriface-host)
  --web-origin <url> print <url>/pair#… instead of doriface://pair#… (both are mesh join arguments)
  --hc <path>        mesh join without a running host: the herdr-core binary (default hc)
  --session <name>   mesh join without a running host: the hc session this host serves
  --wait-host <secs> mesh join: wait up to <secs> for the running host (a service still starting), and fail if none answers
  --from-file <file> mesh join: read the link or code from <file>, so it is never on the command line where other
                     local users can read it`;

/** What `mesh join` says when the join withdrew this host's own open mesh invite (#2117). */
export const OFFER_WITHDRAWN_NOTICE =
  "withdrew this host's own open mesh invite: a host cannot invite into its mesh while it joins another\n";

/** The link or code to join: the argument, or the first line of `--from-file`, never both (#821). */
export function joinTargetOf(positional: string | undefined, fromFile: string | undefined): string {
  if (positional !== undefined && fromFile !== undefined) {
    throw new Error("mesh join takes a link or code, or --from-file, not both");
  }
  if (fromFile === undefined) {
    if (positional === undefined) throw new Error("mesh join needs a mesh pairing link or code");
    return positional;
  }
  const given = readFileSync(fromFile, "utf8").trim();
  if (given === "") throw new Error(`${fromFile} holds no mesh pairing link or code`);
  return given;
}

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
      "web-origin": { type: "string" },
      relay: { type: "string", default: DEFAULT_RELAY_URL },
      "state-dir": { type: "string" },
    },
  });
  const webOrigin = values["web-origin"];
  if (webOrigin !== undefined) pairingWebOrigin(webOrigin);
  relayWebSocketUrl(values.relay);
  const stateDir = values["state-dir"] ?? defaultStateDir();
  const identity = loadHostIdentity(stateDir);
  const answer = await requestControl(stateDir, { op: "mesh-pair", auto: values.auto });
  if (answer === undefined) throw new Error("doriface-host is not running on this state dir: it serves the join");
  const offer = pendingFromWire(answer);
  const artifact = pairingArtifact(
    {
      hostId: identity.hostId,
      noiseStaticPub: identity.noise.publicKey,
      signPub: identity.sign.publicKey,
      linkSecret: offer.linkSecret,
      relayUrl: values.relay,
      mesh: true,
    },
    webOrigin,
  );
  out(
    [
      "On the machine that joins, run: doriface-host mesh join '<this link>' (or the code with --fingerprint).",
      "This link is a mesh join argument, not a page to open; it will reach every machine in the mesh, and so will every device paired to it.",
      "",
      ...(values["no-qr"] ? [] : [renderUnicodeCompact(artifact.url, { ecc: "L", border: 2 }), ""]),
      artifact.url,
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
  const { nonce, name, kind, code } = pending;
  if (typeof code !== "string") throw new Error("update the inviting host to compare a join code");
  out("Compare by a call or in person, not in the chat that carried the link.\n");
  const approve = await ask(
    `admit "${String(name)}" (${kind === "client" ? "browser" : "machine"}) code ${code}? Approve only if the joining screen shows the same code`,
    out,
  );
  const decided = await requestControl(stateDir, { op: "mesh-approve", nonce, approve, code });
  const done = isRecord(decided) && decided["decided"] === true;
  out(
    done
      ? approve
        ? "approved; waiting for the joiner to confirm the code\n"
        : "denied\n"
      : "the join expired or was decided elsewhere\n",
  );
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
      "wait-host": { type: "string" },
      "from-file": { type: "string" },
    },
  });
  const given = joinTargetOf(positionals[0], values["from-file"]);
  const wait = values["wait-host"] === undefined ? undefined : waitSeconds(values["wait-host"]);
  const target = parseTarget(given);
  const stateDir = values["state-dir"] ?? defaultStateDir();
  if (wait !== undefined) await waitForHost(stateDir, Date.now() + wait * 1000, out);
  const yes = values.yes;
  const canAsk = process.stdin.isTTY === true;
  const inviter = target.kind === "link" ? target.link.hostId : "the inviting machine";
  const confirm = async (code: string): Promise<boolean> => {
    out("Compare by a call or in person, not in the chat that carried the link.\n");
    const matched = await ask(`does ${inviter} show code ${code}?`, out);
    if (matched) out(`waiting for approval on ${inviter}\n`);
    return matched;
  };
  const request = {
    target: given,
    fingerprint: values.fingerprint,
    name: values.name,
    relay: values.relay,
    yes,
    ask: canAsk,
  };
  if (await controlIsLive(stateDir)) {
    const joined = await requestControl(stateDir, { op: "mesh-join", ...request }, confirm);
    const meshId = isRecord(joined) ? joined["meshId"] : undefined;
    if (isRecord(joined) && joined["withdrewOffer"] === true) out(OFFER_WITHDRAWN_NOTICE);
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
    ask: canAsk,
    confirm,
    relayUrl: values.relay,
    defaultRelayUrl: DEFAULT_RELAY_URL,
    proofs: await openReadOnlyRelayPasses(stateDir, identity, log),
    log,
  });
  joined.secure.close();
  if (joined.withdrewOffer) out(OFFER_WITHDRAWN_NOTICE);
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
