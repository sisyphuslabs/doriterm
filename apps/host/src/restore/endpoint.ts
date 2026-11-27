import {
  answerRestoreNoise,
  base64urlEncode,
  decodeRestoreFrame,
  encodeRestoreFrame,
  RESTORE_CHALLENGE_BYTES,
  RESTORE_FIRST_BYTES,
  RESTORE_REQUEST_BYTES,
  type StaticKey,
} from "@doriface/crypto";
import { isKey } from "@doriface/mesh";
import { readRestoreMessage, type ByteLink } from "@doriface/relay-client";
import { isRecord } from "../state/files.ts";
import type { RestoreBudget } from "./budget.ts";

const PREPARE_MS = 250;
const EMPTY = new Uint8Array(0);

export interface RestoreReply {
  readonly json: unknown;
  readonly data?: Uint8Array<ArrayBuffer>;
}

interface Endpoint {
  readonly holder: StaticKey;
  readonly budget: RestoreBudget;
  readonly available: () => boolean;
  answer(request: Readonly<Record<string, unknown>>, lookup: string, challenge: string): RestoreReply | undefined;
}

/** No member parser or member session sees this traffic. Only the authenticated relay can open this endpoint. */
export async function serveRestore(link: ByteLink, endpoint: Endpoint): Promise<void> {
  try {
    if (!endpoint.available() || !endpoint.budget.handshake(Date.now())) return;
    const first = await readRestoreMessage(link, RESTORE_FIRST_BYTES);
    const challenge = crypto.getRandomValues(new Uint8Array(RESTORE_CHALLENGE_BYTES));
    const { second, receive, send } = await answerRestoreNoise(endpoint.holder, first, challenge);
    const frame = await readRestoreMessage(link, RESTORE_REQUEST_BYTES, () => link.send(second));
    const releaseAt = performance.now() + PREPARE_MS;
    let response = encodeRestoreFrame("response", null);
    try {
      const { json, data } = decodeRestoreFrame("request", receive.decryptWithAd(EMPTY, frame));
      if (
        data.byteLength === 0 &&
        isRecord(json) &&
        isKey(json["lookup"]) &&
        endpoint.budget.lookup(json["lookup"], Date.now())
      ) {
        const reply = endpoint.answer(json, json["lookup"], base64urlEncode(challenge));
        if (reply !== undefined) response = encodeRestoreFrame("response", reply.json, reply.data);
      }
    } catch {
      // A malformed or unauthenticated request is indistinguishable from a nonexistent lookup.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, releaseAt - performance.now())));
    await link.send(send.encryptWithAd(EMPTY, response));
  } catch {
    // Deliberately no anonymous request logging, including invalid messages.
  } finally {
    link.close();
  }
}
