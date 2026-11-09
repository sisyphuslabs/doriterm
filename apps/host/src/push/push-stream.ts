import { CloseCode } from "@doriface/crypto";
import {
  encodePushLine,
  MAX_PUSH_LINE,
  type PushClientLine,
  type PushHostLine,
  parsePushClientLine,
} from "@doriface/protocol";
import type { PushService } from "./push-service.ts";

/** What the push stream needs of a session: the E2EE session's plaintext, or the loopback `/v1/push` socket. */
export interface PushLink {
  send(bytes: Uint8Array): unknown;
  onData(handler: (bytes: Uint8Array) => unknown): unknown;
  onClose(handler: () => void): unknown;
  close(code?: number, reason?: string): void;
}

const ok: PushHostLine = { t: "ok" };
const error = (reason: string): PushHostLine => ({ t: "error", reason });

async function reply(
  line: PushClientLine | { readonly t: "unknown" },
  owner: string,
  service: PushService,
  focus: (terminal: string | null) => void,
): Promise<PushHostLine> {
  switch (line.t) {
    case "hello":
      return { t: "ready", vapidKey: service.vapidKey, subscriptions: service.held(owner) };
    case "subscribe":
      return (await service.subscribe(owner, line.subscription, line.prefs))
        ? ok
        : error("this push service is not one the host posts to");
    case "prefs":
      return service.setPrefs(owner, line.endpoint, line.prefs) ? ok : error("no such subscription");
    case "unsubscribe":
      service.unsubscribe(owner, line.endpoint);
      return ok;
    case "test":
      return (await service.test(owner, line.endpoint)) ? ok : error("no such subscription");
    case "focus":
      focus(line.terminal);
      return ok;
    case "notice": {
      const entry = service.resolve(line.id);
      const prompt = service.prompt(entry);
      const context = service.context(entry);
      return {
        t: "notice",
        terminal: entry?.terminal ?? null,
        kind: entry?.kind ?? null,
        ...(prompt === undefined ? {} : { prompt }),
        ...(context === undefined ? {} : { context }),
      };
    }
    case "answer":
      return service.answer(line.id, line.answer, owner);
    case "choose":
      return service.choose(line.id, line.option, owner);
    case "unknown":
      return error("unknown line");
  }
}

/**
 * Serves one device's push stream (contract v1.7): one reply line per client line, in order. A line that is too long
 * or not an object with a string `t` closes the session 4400; while the stream is open the device counts as present.
 */
export function servePushStream(link: PushLink, owner: string, service: PushService): void {
  const presence = service.presence(owner);
  link.onClose(() => presence.leave());
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let buffer = "";
  let replies = Promise.resolve();
  let closed = false;
  const refuse = (reason: string): void => {
    closed = true;
    link.close(CloseCode.CryptoFailure, reason);
  };
  const take = (text: string): void => {
    let line: PushClientLine | { readonly t: "unknown" };
    try {
      line = parsePushClientLine(text);
    } catch (failure) {
      refuse(`a push line: ${failure instanceof Error ? failure.message : String(failure)}`);
      return;
    }
    replies = replies.then(() => answer(line)).then(write);
  };
  /** A failing reply (a state file that cannot be written) is answered as an error; later lines still get theirs. */
  const answer = async (line: PushClientLine | { readonly t: "unknown" }): Promise<PushHostLine> => {
    try {
      return await reply(line, owner, service, presence.focus);
    } catch (failure) {
      return error(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const write = (line: PushHostLine): void => {
    if (!closed) link.send(encoder.encode(encodePushLine(line)));
  };
  link.onData((bytes) => {
    if (closed) return;
    try {
      buffer += decoder.decode(bytes, { stream: true });
    } catch {
      refuse("a push line is not UTF-8");
      return;
    }
    let end = buffer.indexOf("\n");
    while (end !== -1) {
      take(buffer.slice(0, end));
      if (closed) return;
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
    }
    if (encoder.encode(buffer).byteLength >= MAX_PUSH_LINE) refuse("a push line is too long");
  });
}
