import { rawStaticKey, secureLink, type SecureLink, type Stream } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { type CardBody, signCard } from "@doriface/mesh";
import { MeshLines } from "@doriface/mesh/join";
import type { PlanPolicy } from "@doriface/policy";
import { createGateway } from "../gateway.ts";
import { cardBody } from "../state/mesh.ts";
import { side } from "./join-harness.ts";
import { noiseOf, signPubOf } from "./mesh-history.ts";
import { clearRosterResumes, fixture } from "./roster-resume-harness.ts";
import { recordingPipe } from "./gateway-harness.ts";
import { IDLE_MESH_HOOKS } from "../mesh/host-hooks.ts";
import { storedMeshStatus } from "../mesh/status-store.ts";

const closes: (() => void)[] = [];
export function clearClientSessions(): void {
  for (const close of closes.splice(0)) close();
  clearRosterResumes();
}

export function clients() {
  const f = fixture();
  const other = side("other-browser");
  const mesh = f.a.mesh.read()?.meshId ?? "";
  for (const client of [f.c, other]) {
    const card = signCard(
      cardBody(
        client.m.identity,
        {
          name: client.m.name,
          hcId: "",
          devicePub: noiseOf(client.m),
        },
        mesh,
        signPubOf(f.a.m),
        undefined,
        "client",
      ),
      client.m.identity.sign.secretKey,
    );
    f.a.mesh.sign(f.a.m.identity, (n, prev) => ({
      v: 2,
      mesh,
      type: "admit",
      by: signPubOf(f.a.m),
      n,
      prev,
      subject: { card },
    }));
  }
  return { ...f, other, mesh };
}

export const status = (f: ReturnType<typeof clients>, store = f.a.mesh) =>
  storedMeshStatus(store, f.a.m.identity, IDLE_MESH_HOOKS);
export const lastSeen = (f: ReturnType<typeof clients>, store = f.a.mesh) =>
  status(f, store)?.members.find((member) => member.hostId === f.c.m.identity.hostId)?.lastSessionAt;

/** Uses the real gateway, admission barriers, and roster handler, with a recording hc pipe. */
export async function connectClient(
  f: ReturnType<typeof clients>,
  stream: Stream | undefined,
  options: {
    readonly policy?: PlanPolicy;
    readonly beforeAdmission?: (secure: SecureLink) => void;
    readonly card?: (body: CardBody) => CardBody;
  } = {},
) {
  const pipe = recordingPipe();
  const [hostEnd, clientEnd] = memoryLinkPair(true);
  const gateway = createGateway({
    token: "t".repeat(32),
    hostVersion: "0",
    hcVersion: "0",
    openPipe: () => pipe.child,
    log: (line) => {
      f.a.logs.push(line);
    },
    e2ee: {
      ...f.deps,
      sessions: f.deps.live,
      policy: options.policy ?? f.deps.policy,
      rosterStream: (secure) => f.host.roster(secure),
      ...(options.beforeAdmission === undefined ? {} : { meshPresence: options.beforeAdmission }),
    },
    push: () => {},
  });
  const served = gateway
    .serveE2ee(
      Object.assign(hostEnd, {
        flushed: () => Promise.resolve(),
        readWhen() {},
      }),
      { kind: "relay" },
    )
    .catch((error: unknown) => {
      hostEnd.close(1011, "internal error");
      return error instanceof Error ? error.message : String(error);
    });
  const client = await secureLink(clientEnd, {
    role: "initiator",
    hostId: f.a.m.identity.hostId,
    staticKey: rawStaticKey(f.c.m.identity.noise),
    remoteStatic: f.a.m.identity.noise.publicKey,
    ...(stream === undefined ? {} : { stream }),
  }).catch(() => undefined);
  closes.push(() => {
    client?.close();
    hostEnd.close();
    pipe.child.close();
  });
  const error = await served;
  let reply: string | undefined;
  if (client !== undefined && stream === "roster" && hostEnd.closeCode === undefined) {
    const lines = new MeshLines(client, ["offer", "records", "done", "refused"]);
    const offer = await lines.next();
    if (offer.t !== "offer") throw new Error("no roster offer");
    const body = cardBody(
      f.c.m.identity,
      {
        name: "browser",
        hcId: "",
        devicePub: noiseOf(f.c.m),
      },
      offer.mesh,
      offer.inviter,
      offer.nonce,
      "client",
    );
    lines.send({ t: "card", ...signCard(options.card?.(body) ?? body, f.c.m.identity.sign.secretKey) });
    reply = (await lines.next()).t;
    if (reply === "records" && (await lines.next()).t !== "done") throw new Error("no roster completion");
  }
  return { client, hostEnd, error, pipe, reply };
}

export async function accept(f: ReturnType<typeof clients>, stream: Stream | undefined) {
  const dial = await connectClient(f, stream);
  return dial.hostEnd.closeCode === undefined || dial.reply === "records" ? dial.client : undefined;
}
