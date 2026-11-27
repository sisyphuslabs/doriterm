import {
  base64urlDecode,
  base64urlEncode,
  decodeRestoreFrame,
  encodeRestoreFrame,
  openRestoreNoise,
  RESTORE_RESPONSE_BYTES,
  RESTORE_SECOND_BYTES,
  secureLink,
} from "@doriface/crypto";
import { connectRelayClient, readRestoreMessage, restoreLink } from "@doriface/relay-client";
import type { BrowserIdentity } from "../mesh/identity.ts";
import type { RestoreHolder } from "./blobs.ts";

const empty = new Uint8Array(0);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function anonymousRestore(
  relayUrl: string,
  holder: RestoreHolder,
  request: (challenge: string) => unknown,
): Promise<ReturnType<typeof decodeRestoreFrame>> {
  const link = await restoreLink(relayUrl, holder.hostId);
  try {
    const nk = openRestoreNoise(base64urlDecode(holder.hostKey));
    const second = await readRestoreMessage(link, RESTORE_SECOND_BYTES, () => link.send(nk.first));
    const { send, receive, challenge } = nk.finish(second);
    const packet = encodeRestoreFrame("request", request(base64urlEncode(challenge)));
    const reply = await readRestoreMessage(link, RESTORE_RESPONSE_BYTES, () =>
      link.send(send.encryptWithAd(empty, packet)),
    );
    return decodeRestoreFrame("response", receive.decryptWithAd(empty, reply));
  } finally {
    link.close();
  }
}

export async function restoreOwner(
  relayUrl: string,
  holder: RestoreHolder,
  identity: BrowserIdentity,
  request: unknown,
): Promise<unknown> {
  const link = await connectRelayClient({ relayUrl, hostId: holder.hostId });
  try {
    const secure = await secureLink(link, {
      role: "initiator",
      hostId: holder.hostId,
      staticKey: identity.device,
      remoteStatic: base64urlDecode(holder.hostKey),
      stream: "restore-owner",
    });
    try {
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const off = secure.onData((bytes) => {
        try {
          resolve(JSON.parse(decoder.decode(bytes)));
        } catch (error) {
          reject(error);
        }
      });
      const close = secure.onClose(() => reject(new Error("the restore owner link closed")));
      const timer = setTimeout(() => reject(new Error("the restore owner request timed out")), 10_000);
      try {
        secure.send(encoder.encode(JSON.stringify(request)));
        return await promise;
      } finally {
        off();
        close();
        clearTimeout(timer);
      }
    } finally {
      secure.close();
    }
  } finally {
    link.close();
  }
}
