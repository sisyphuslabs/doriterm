import type { CardBody, Signed } from "@doriface/mesh";
import { JoinRefused, type MeshLines, MeshProtocolError, recordLines } from "@doriface/mesh/join";
import type { PendingJoin, PendingJoins } from "./pending-joins.ts";

export interface ResumableJoin {
  readonly join: PendingJoin;
  readonly card: CardBody;
  readonly Ni: string;
  readonly welcome: Promise<readonly Signed[]>;
  readonly records: () => readonly Signed[];
}

/** A spent offer belongs to the card's device key until its original expiry, even after admission. */
export class JoinResumes {
  readonly #joins = new Map<string, { readonly value: ResumableJoin; readonly timer: ReturnType<typeof setTimeout> }>();

  keep(value: ResumableJoin): void {
    const timer = setTimeout(() => this.drop(value.join.nonce), Math.max(0, value.join.expiresAt - Date.now()));
    timer.unref();
    this.#joins.set(value.join.nonce, { value, timer });
    void value.welcome.catch(() => this.drop(value.join.nonce));
  }

  get(nonce: string, devicePub: string, now = Date.now()): ResumableJoin | undefined {
    const entry = this.#joins.get(nonce)?.value;
    return entry?.card.devicePub === devicePub && now < entry.join.expiresAt ? entry : undefined;
  }

  drop(nonce: string): void {
    const entry = this.#joins.get(nonce);
    if (entry !== undefined) clearTimeout(entry.timer);
    this.#joins.delete(nonce);
  }

  clear(): void {
    for (const nonce of this.#joins.keys()) this.drop(nonce);
  }
}

/** Either session may carry confirmation; losing it never withdraws the pending admission. */
export async function finishJoin(lines: MeshLines, resumed: ResumableJoin, pending: PendingJoins): Promise<void> {
  if (!pending.list().some((join) => join.nonce === resumed.join.nonce)) {
    await resumed.welcome;
    const records = resumed.records();
    for (const line of recordLines(records)) lines.send(line);
    lines.send({ t: "done", mesh: resumed.card.mesh });
    lines.detach();
    return;
  }
  lines.expect("confirm", "abort", "refused");
  const hear = async (): Promise<never> => {
    const line = await lines.next().catch((error: unknown) => {
      if (!(error instanceof MeshProtocolError)) throw error;
      pending.decide(resumed.join.nonce, false);
      throw new JoinRefused(`the session closed before the join was decided: ${error.message}`);
    });
    if (line.t === "confirm") {
      pending.confirm(resumed.join.nonce);
      lines.expect("abort", "refused");
      return hear();
    }
    pending.decide(resumed.join.nonce, false);
    if (line.t === "refused") throw new JoinRefused(`the joiner gave up: ${line.reason}`);
    throw new JoinRefused("not joined");
  };
  const incoming = hear();
  if (lines.closed !== undefined) await incoming;
  lines.send({ t: "reveal", Ni: resumed.Ni });
  const records = await Promise.race([resumed.welcome, incoming]);
  for (const line of recordLines(records)) lines.send(line);
  lines.send({ t: "done", mesh: resumed.card.mesh });
  lines.detach();
}
