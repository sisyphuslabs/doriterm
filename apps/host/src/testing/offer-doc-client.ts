import { HcConnection } from "@doriface/client";
import { isJsonObject, type JsonValue, MESH_OFFER_DOC } from "@doriface/protocol";
import { spawnHcLink } from "../mesh/hc-machines.ts";
import type { createHcSession } from "./hc-session.ts";

type Session = ReturnType<typeof createHcSession>;

/** A client's line to the core: writes the request and waits for the document to reach a value it names. */
export async function client(session: Session) {
  const link = spawnHcLink({ hc: session.hc, session: session.name, env: session.env });
  const core = await HcConnection.open(link);
  const feed = await core.subscribe();
  const waiters = new Set<() => Promise<void>>();
  // Each check a doc event starts; close waits these out, so a read still in flight is not cut off by the close.
  const inFlight = new Set<Promise<void>>();
  feed.onEvent((event) => {
    if (event.type !== "doc" || event.data.name !== MESH_OFFER_DOC) return;
    for (const waiter of waiters) {
      const run = waiter().finally(() => inFlight.delete(run));
      inFlight.add(run);
    }
  });
  const read = async (): Promise<JsonValue> => (await core.call("doc.get", { name: MESH_OFFER_DOC })).value;
  return {
    async request(nonce: string, browser = false): Promise<void> {
      const { version } = await core.call("doc.get", { name: MESH_OFFER_DOC });
      await core.call("doc.set", {
        name: MESH_OFFER_DOC,
        value: { request: nonce, ...(browser ? { client: true } : {}) },
        version,
      });
    },
    /** Resolves with the document once `done` holds for it, checked now and on each doc event. */
    async until(done: (value: JsonValue) => boolean): Promise<JsonValue> {
      const { promise, resolve } = Promise.withResolvers<JsonValue>();
      const check = async (): Promise<void> => {
        const value = await read();
        if (!done(value)) return;
        waiters.delete(check);
        resolve(value);
      };
      // Listening before the first read, so a write between the two is not missed.
      waiters.add(check);
      await check();
      return promise;
    },
    async close(): Promise<void> {
      await Promise.allSettled(inFlight);
      core.close();
      link.close();
    },
  };
}

export const field = (value: JsonValue, key: string): unknown => (isJsonObject(value) ? value[key] : undefined);

export const noJoins = (): (() => void) => () => {};
