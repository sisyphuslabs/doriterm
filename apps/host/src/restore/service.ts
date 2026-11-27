import { base64urlDecode, base64urlEncode, type HostIdentity, rawStaticKey, type SecureLink } from "@doriface/crypto";
import { isKey, parseReadmit, parseReadmitApproval } from "@doriface/mesh";
import type { Signed } from "@doriface/mesh";
import { type ByteLink } from "@doriface/relay-client";
import type { LiveSessions } from "../e2ee/sessions.ts";
import type { HostSync } from "../mesh/host-sync.ts";
import { isRecord } from "../state/files.ts";
import { RESTORE_FORMAT } from "../state/mesh-file.ts";
import type { MeshStore } from "../state/mesh.ts";
import { RestoreBlobs } from "./blobs.ts";
import { RestoreBudget } from "./budget.ts";
import { type RestoreReply, serveRestore } from "./endpoint.ts";
import { mayReadBundle, type RestoreClient, RestoreRequests } from "./requests.ts";

interface Deps {
  readonly stateDir: string;
  readonly identity: HostIdentity;
  readonly mesh: MeshStore;
  readonly sessions: Pick<LiveSessions, "has">;
  readonly sync: Pick<HostSync, "formatReady" | "changed">;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const CLIENT_PRESENCE_MS = 45_000;

/**
 * A readmission receipt is handed back only to a retry of the exact signed request (M10): every signed field plus both
 * signatures. Keying on the signatures alone handed the receipt to a request whose fields had been changed under them.
 */
function receiptKey(proof: NonNullable<ReturnType<typeof parseReadmit>>): string {
  return JSON.stringify([
    proof.old,
    proof.signPub,
    proof.noise,
    proof.name,
    proof.nonce,
    proof.at,
    proof.newSig,
    proof.oldSig ?? "",
  ]);
}

export class RestoreService {
  readonly #deps: Deps;
  readonly #blobs: RestoreBlobs;
  readonly #budget = new RestoreBudget();
  readonly #requests = new RestoreRequests();
  readonly #compatibleClients = new Map<string, number>();
  readonly #recent = new Map<string, { readonly lookup: string; readonly at: number; readonly record: Signed }>();

  constructor(deps: Deps) {
    this.#deps = deps;
    this.#blobs = new RestoreBlobs(deps.stateDir);
  }

  #clients(): readonly RestoreClient[] {
    const now = Date.now();
    return (this.#deps.mesh.authorizeIndex()?.clients() ?? []).flatMap(({ signPub, devicePub }) =>
      devicePub === undefined
        ? []
        : [
            {
              signPub,
              devicePub,
              live:
                this.#deps.sessions.has(devicePub) ||
                (this.#compatibleClients.get(signPub) ?? 0) > now - CLIENT_PRESENCE_MS,
            },
          ],
    );
  }

  prune(): void {
    const clients = new Map(this.#clients().map((client) => [client.signPub, client.devicePub]));
    for (const signPub of this.#compatibleClients.keys())
      if (!clients.has(signPub)) this.#compatibleClients.delete(signPub);
    this.#requests.prune(new Set(clients.keys()));
    this.#blobs.prune((owner) => clients.get(owner.signPub) === owner.devicePub, Date.now());
  }

  touch(secure: SecureLink): void {
    const key = base64urlEncode(secure.remoteStatic);
    const owner = this.#clients().find((client) => client.devicePub === key);
    if (owner !== undefined) this.#blobs.touch(owner, Date.now());
  }

  anonymous(link: ByteLink): Promise<void> {
    this.prune();
    const cutoff = Date.now() - 5 * 60_000;
    for (const [sig, entry] of this.#recent) if (entry.at <= cutoff) this.#recent.delete(sig);
    return serveRestore(link, {
      holder: rawStaticKey(this.#deps.identity.noise),
      budget: this.#budget,
      available: () => !this.#blobs.empty || this.#recent.size !== 0,
      answer: (request, lookup, challenge) => this.#answer(request, lookup, challenge),
    });
  }

  #answer(request: Readonly<Record<string, unknown>>, lookup: string, challenge: string): RestoreReply | undefined {
    const now = Date.now();
    if (request["t"] === "fetch") {
      const envelope = this.#blobs.get(lookup, now);
      if (envelope === undefined) return undefined;
      const { version, epoch, blob } = envelope;
      const mesh = this.#deps.mesh.read()?.meshId;
      return mesh === undefined
        ? undefined
        : { json: { t: "blob", mesh, version, epoch }, data: Uint8Array.from(blob) };
    }
    const file = this.#deps.mesh.read();
    if (file === undefined) return undefined;
    const clients = this.#clients();
    if (request["t"] === "bundle") {
      const { old, sig } = request;
      if (
        typeof old !== "string" ||
        typeof sig !== "string" ||
        !mayReadBundle(new Set(clients.map((client) => client.signPub)), { old, sig, challenge })
      )
        return undefined;
      return { json: { t: "bundle", mesh: file.meshId, records: file.records } };
    }
    if (request["t"] !== "readmit") return undefined;
    const proof = parseReadmit(request["proof"]);
    if (proof === undefined) return undefined;
    const receipt = this.#recent.get(receiptKey(proof));
    if (receipt?.lookup === lookup) return { json: { t: "admitted", record: receipt.record } };
    const owner = clients.find((client) => client.signPub === proof.old);
    if (owner === undefined || !this.#blobs.owns(lookup, owner, now)) return undefined;
    const result = this.#requests.offer(file.meshId, proof, clients);
    if (result.kind === "empty") return undefined;
    const capable = clients.every(
      (client) => client.signPub === proof.old || this.#compatibleClients.has(client.signPub),
    );
    if (!this.#deps.sync.formatReady(file.records, undefined, RESTORE_FORMAT)) return { json: { t: "invite" } };
    if (result.kind !== "approved") return { json: { t: result.kind } };
    if (!capable) return { json: { t: "invite" } };
    return this.#publish(file.meshId, lookup, result.proof);
  }

  #publish(
    mesh: string,
    lookup: string,
    proof: NonNullable<ReturnType<typeof parseReadmit>>,
  ): RestoreReply | undefined {
    const { identity, sync } = this.#deps;
    const signed = this.#deps.mesh.transact((tx) => {
      if (!sync.formatReady(tx.records, tx.view(), RESTORE_FORMAT)) return undefined;
      return tx.sign(identity, (n, prev) => ({
        v: 3,
        mesh,
        by: base64urlEncode(identity.sign.publicKey),
        n,
        prev,
        type: "readmit",
        subject: proof,
      }));
    });
    if (signed === undefined) return { json: { t: "invite" } };
    this.#recent.set(receiptKey(proof), { lookup, at: Date.now(), record: signed });
    sync.changed();
    this.prune();
    return { json: { t: "admitted", record: signed } };
  }

  owner(secure: SecureLink): void {
    const device = base64urlEncode(secure.remoteStatic);
    secure.onData((bytes) => {
      try {
        const owner = this.#clients().find((client) => client.devicePub === device);
        const request: unknown = JSON.parse(decoder.decode(bytes));
        const reply = owner !== undefined && isRecord(request) ? this.#ownerRequest(owner, request) : undefined;
        secure.send(encoder.encode(JSON.stringify(reply ?? null)));
      } catch {
        secure.close(1008, "invalid restore owner request");
      }
    });
  }

  #ownerRequest(owner: RestoreClient, request: Readonly<Record<string, unknown>>): unknown {
    const now = Date.now();
    switch (request["t"]) {
      case "put": {
        const { lookup, version, epoch, blob } = request;
        if (
          !isKey(lookup) ||
          typeof version !== "number" ||
          typeof epoch !== "number" ||
          typeof blob !== "string" ||
          !/^[A-Za-z0-9_-]+$/.test(blob)
        )
          return undefined;
        return this.#blobs.put(owner, { lookup, version, epoch, blob: base64urlDecode(blob) }, now);
      }
      case "remove":
        this.#blobs.remove(owner, now);
        return true;
      case "pending":
        this.#compatibleClients.set(owner.signPub, now);
        return this.#requests.forClient(owner.signPub);
      case "answer": {
        const mesh = this.#deps.mesh.read()?.meshId;
        const proof = parseReadmit(request["proof"]);
        const approval = request["approval"] === null ? null : parseReadmitApproval(request["approval"]);
        return (
          mesh !== undefined &&
          proof !== undefined &&
          approval !== undefined &&
          this.#requests.answer(mesh, proof, owner.signPub, approval)
        );
      }
      default:
        return undefined;
    }
  }
}
