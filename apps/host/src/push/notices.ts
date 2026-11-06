import { base64urlEncode } from "@doriface/crypto";
import type { ApprovalMark, NoticeKind } from "@doriface/protocol";

export interface NoticeEntry {
  /** Null for a test notice. */
  readonly terminal: string | null;
  readonly kind: NoticeKind;
  readonly at: number;
  /** A permission or question notice's prompt as it stood when the notice was made; an answer is checked against it. */
  readonly mark: ApprovalMark | undefined;
}

export const NOTICE_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_NOTICES = 200;

/**
 * Notice id -> terminal, in memory only: the id is all a push carries, and only a device on the E2EE push stream can
 * turn it back into a terminal. A permission notice takes one answer; a second one, even a racing one, is stale.
 */
export class NoticeBook {
  readonly #entries = new Map<string, NoticeEntry>();

  add(entry: NoticeEntry): string {
    const id = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    this.#entries.set(id, entry);
    for (const old of this.#entries.keys()) {
      if (this.#entries.size <= MAX_NOTICES) break;
      this.#entries.delete(old);
    }
    return id;
  }

  get(id: string, now: number): NoticeEntry | undefined {
    const entry = this.#entries.get(id);
    return entry === undefined || now - entry.at > NOTICE_LIFETIME_MS ? undefined : entry;
  }
}
