import { base64urlDecode, base64urlEncode, CloseCode } from "@doriface/crypto";
import { MAX_RECORDS, type MemberKind, type Signed } from "../records/types.ts";
import { joinCode, joinCommit } from "./code.ts";
import type { Offer } from "./joiner.ts";
import { type MeshLine, type MeshLines, MeshProtocolError } from "./lines.ts";
import { byDeadline, JoinRefused } from "./refused.ts";

export const JOIN_NO_TERMINAL =
  "this invite asks for a code: run `doriface-host mesh join <link>` in a terminal, or use Add a machine's one-line command";
export const JOIN_NO_COMMIT =
  "this invite does not ask for a code: either the inviting machine needs an update, or it is a one-line Add a machine invite (run that command as given). Or ask for an invite with `doriface-host mesh pair` on an updated machine";

/** Persisted before the first card; this is an unfinished join, never a membership bundle. */
export interface JoinAnchor {
  readonly offer: Offer & { readonly commit: string };
  readonly dialed: { readonly hostId: string; readonly noisePub: string };
  readonly h: string;
  readonly Nj: string;
  readonly expiresAt: number;
  /** Remember the person's answer so an already admitted resume may receive the welcome directly. */
  readonly confirmed: boolean;
}

export interface JoinCeremony {
  readonly kind: MemberKind;
  readonly handshakeHash: Uint8Array;
  /** The authenticated inviter; a resumer must dial the anchor's pinned key before calling this function. */
  readonly dialed: JoinAnchor["dialed"];
  readonly expiresAt: number;
  readonly yes: boolean;
  /** Absent when there is no terminal or UI to ask on. `yes` never supplies this answer. */
  readonly confirm: ((code: string) => Promise<boolean>) | undefined;
  /** Supports a non-extractable browser signing key as well as a host's raw key. */
  readonly card: (offer: Offer) => Promise<Signed>;
  readonly saveAnchor: (anchor: JoinAnchor) => Promise<void>;
  readonly clearAnchor: () => Promise<void>;
  readonly resume?: JoinAnchor | undefined;
}

export interface JoinWelcome {
  readonly offer: Offer;
  /** Untrusted until checkWelcome has verified them; never store these on receipt alone. */
  readonly records: readonly Signed[];
}

/** Shared browser/CLI ceremony. Transport loss keeps the anchor; denial, mismatch and expiry remove it. */
export async function runJoinCeremony(lines: MeshLines, ctx: JoinCeremony): Promise<JoinWelcome> {
  let anchor = ctx.resume;
  let sentCard = ctx.resume !== undefined;
  const expiresAt = anchor?.expiresAt ?? ctx.expiresAt;
  const run = async (): Promise<JoinWelcome> => {
    if (Date.now() >= expiresAt) throw new JoinRefused("Ask for a new invite");
    let offer: Offer;
    if (anchor !== undefined) {
      if (anchor.dialed.hostId !== ctx.dialed.hostId || anchor.dialed.noisePub !== ctx.dialed.noisePub) {
        throw new JoinRefused("the resumed invite is pinned to another machine");
      }
      offer = anchor.offer;
      lines.expect("offer", "reveal", "refused", ...(anchor.confirmed ? (["records", "done"] as const) : []));
      lines.send({ t: "resume", nonce: offer.nonce });
    } else {
      const first = await lines.next();
      if (first.t === "refused") throw new JoinRefused(first.reason);
      if (first.t !== "offer") throw new JoinRefused(`expected an offer, got ${first.t}`);
      offer = first;
      if (offer.commit === undefined) {
        if (ctx.kind === "client" || !ctx.yes) throw new JoinRefused(JOIN_NO_COMMIT);
        lines.expect("records", "done", "refused");
        lines.send({ t: "card", ...(await ctx.card(offer)) });
        return { offer, records: await readWelcome(lines, offer.mesh) };
      }
      if (ctx.confirm === undefined) throw new JoinRefused(JOIN_NO_TERMINAL);
      anchor = {
        offer: { ...offer, commit: offer.commit },
        dialed: ctx.dialed,
        h: base64urlEncode(ctx.handshakeHash),
        Nj: base64urlEncode(crypto.getRandomValues(new Uint8Array(32))),
        expiresAt,
        confirmed: false,
      };
      await ctx.saveAnchor(anchor);
      const signed = await ctx.card(offer);
      lines.expect("reveal", "refused");
      lines.send({ t: "card", ...signed, sas: anchor.Nj });
      sentCard = true;
    }
    let reveal = await lines.next();
    // A client already admitted is offered a normal roster refresh. Resume still uses only its original anchor.
    if (ctx.resume !== undefined && reveal.t === "offer") {
      if (reveal.mesh !== anchor.offer.mesh || reveal.inviter !== anchor.offer.inviter) {
        throw new JoinRefused("the roster offer is for another invite");
      }
      reveal = await lines.next();
    }
    if (reveal.t === "refused") {
      throw new JoinRefused(ctx.resume === undefined ? reveal.reason : "Ask for a new invite");
    }
    if (anchor.confirmed && (reveal.t === "records" || reveal.t === "done")) {
      return { offer, records: await readWelcome(lines, offer.mesh, reveal) };
    }
    if (reveal.t !== "reveal") throw new JoinRefused(`expected a reveal, got ${reveal.t}`);
    const Ni = base64urlDecode(reveal.Ni);
    const h = base64urlDecode(anchor.h);
    if (joinCommit(h, Ni) !== anchor.offer.commit) throw new JoinRefused("the reveal does not open the commitment");
    lines.expect("refused");
    const code = joinCode(h, Ni, base64urlDecode(anchor.Nj));
    const incoming = lines.next();
    if (!anchor.confirmed) {
      const refused = incoming.then((line) => {
        throw new JoinRefused(line.t === "refused" ? line.reason : `unexpected ${line.t}`);
      });
      const confirmed = await Promise.race([ctx.confirm?.(code) ?? Promise.resolve(false), refused]);
      if (!confirmed) throw new JoinRefused("not joined");
      anchor = { ...anchor, confirmed: true };
      await ctx.saveAnchor(anchor);
    }
    lines.expect("records", "done", "refused");
    lines.send({ t: "confirm" });
    return { offer, records: await readWelcome(lines, offer.mesh, await incoming) };
  };
  try {
    return await byDeadline(run(), expiresAt, "Ask for a new invite");
  } catch (error) {
    if (
      !sentCard ||
      error instanceof JoinRefused ||
      error instanceof MeshProtocolError ||
      lines.closed instanceof MeshProtocolError
    ) {
      if (sentCard && lines.closed === undefined) lines.send({ t: "abort" });
      await ctx.clearAnchor();
    }
    lines.close(CloseCode.UnknownDevice, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function readWelcome(lines: MeshLines, mesh: string, first?: MeshLine): Promise<readonly Signed[]> {
  const records: Signed[] = [];
  const read = async (line: MeshLine): Promise<readonly Signed[]> => {
    if (line.t === "records") {
      records.push(...line.records);
      if (records.length > MAX_RECORDS) throw new JoinRefused("the welcome holds more records than a mesh may");
      return read(await lines.next());
    }
    if (line.t === "refused") throw new JoinRefused(line.reason);
    if (line.t !== "done" || line.mesh !== mesh) throw new JoinRefused("the welcome ended for another mesh");
    lines.expect();
    return records;
  };
  return read(first ?? (await lines.next()));
}
