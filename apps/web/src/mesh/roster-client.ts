import { MAX_RECORDS, type Signed } from "@doriface/mesh";
import { JoinRefused, type MeshLines } from "@doriface/mesh/join";
import type { BrowserIdentity } from "../mesh/identity.ts";
import { browserCard } from "./browser-card.ts";
import type { MembershipStore } from "./membership.ts";

export interface RosterContext {
  readonly identity: BrowserIdentity;
  readonly bundle: MembershipStore;
  readonly source: { readonly hostId: string; readonly hostKey: string };
  readonly name: string;
  readonly relayUrl?: string;
  readonly action: "refresh" | "leave";
}

/** One roster conversation, shared by migration, refresh and this client's own leave. */
export async function exchangeRoster(lines: MeshLines, context: RosterContext): Promise<void> {
  try {
    const offer = await lines.next();
    if (offer.t === "refused") throw new JoinRefused(offer.reason);
    if (offer.t !== "offer") throw new JoinRefused("The machine did not offer a roster.");
    const card = await browserCard(context.identity, context.name, offer);
    lines.expect("records", "done", "refused");
    lines.send(context.action === "leave" ? { t: "leave", card } : { t: "card", ...card });
    const records: Signed[] = [];
    const receive = async (): ReturnType<MeshLines["next"]> => {
      const line = await lines.next();
      if (line.t !== "records") return line;
      records.push(...line.records);
      if (records.length > MAX_RECORDS) throw new JoinRefused("The roster holds too many records.");
      return receive();
    };
    const line = await receive();
    if (line.t === "refused") throw new JoinRefused(line.reason);
    if (line.t !== "done" || line.mesh !== offer.mesh) throw new JoinRefused("The roster ended for another mesh.");
    lines.expect();
    const source = { ...context.source, mesh: offer.mesh, inviter: offer.inviter };
    if (context.bundle.snapshot().phase === "empty") await context.bundle.accept(records, source, context.relayUrl);
    else await context.bundle.refresh(records, source);
    if (context.action === "leave" && context.bundle.snapshot().phase !== "removed") {
      throw new JoinRefused("The machine did not confirm this browser's removal.");
    }
  } finally {
    lines.close(1000, "roster complete");
  }
}
