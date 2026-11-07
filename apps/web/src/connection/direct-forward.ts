import type { ByteLink } from "@doriface/client";
import { directForwardBridge } from "../desktop/bridge.ts";
import { DirectFailure, openDirectLink } from "./direct-attempt.ts";

/** Whether a plain `ws://` address to another machine can be reached at all here: only through the desktop shell (#449). */
export function canForwardPlainWs(scope: object = globalThis): boolean {
  return directForwardBridge(scope) !== null;
}

/**
 * Opens the host's direct address through the desktop shell's byte forwarder. The shell copies ciphertext bytes to the
 * address it holds itself, so this page never opens a socket to another machine and the shell never sees plaintext.
 */
export async function openForwardedLink(target: string, signal: AbortSignal | undefined): Promise<ByteLink> {
  const bridge = directForwardBridge();
  if (bridge === null) throw new DirectFailure("blocked", "this page can't open ws:// to another machine; use wss://");
  await bridge.setTarget(target);
  const answer = await bridge.forward();
  if ("refused" in answer) throw new DirectFailure("blocked", answer.refused);
  try {
    return await openDirectLink(answer.url, signal);
  } catch (error) {
    await bridge.cancel(answer.url);
    throw error;
  }
}
