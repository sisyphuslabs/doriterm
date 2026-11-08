import type { EventFeed, HcConnection } from "@doriface/client";
import { MESH_OFFER_DOC, parseMeshOfferDoc } from "@doriface/protocol";
import { useEffect, useState } from "react";

export const INSTALL_SCRIPT_URL = "https://github.com/sisyphuslabs/doriterm/releases/latest/download/install.sh";

/** How long a host gets to answer before the dialog says it cannot make a join command (a host older than #668). */
export const OFFER_ANSWER_MS = 15_000;

/** The one line to run on the machine to add: install (or update) the host as a service, then join this mesh. */
export function joinCommand(link: string): string {
  return `curl -fsSL ${INSTALL_SCRIPT_URL} | sh -s -- --join '${link.replaceAll("'", "'\\''")}'`;
}

export type JoinOffer =
  | { readonly phase: "asking" }
  | { readonly phase: "ready"; readonly command: string; readonly link: string; readonly expiresAt: number }
  | { readonly phase: "expired" }
  | { readonly phase: "joined"; readonly name: string }
  | { readonly phase: "failed"; readonly reason: string };

interface OfferCalls {
  get(): Promise<{ value: unknown; version: number }>;
  set(value: { request: string; client?: true }, version: number): Promise<unknown>;
}

const callsOf = (connection: HcConnection): OfferCalls => ({
  get: () => connection.call("doc.get", { name: MESH_OFFER_DOC }),
  set: (value, version) => connection.call("doc.set", { name: MESH_OFFER_DOC, value, version }),
});

/** What the offer document says about this request, or undefined while the host has not answered it. */
export function offerFor(value: unknown, request: string): JoinOffer | undefined {
  const doc = parseMeshOfferDoc(value);
  if (doc?.request !== request) return undefined;
  if ("link" in doc) return { phase: "ready", command: joinCommand(doc.link), link: doc.link, expiresAt: doc.expiresAt };
  if ("error" in doc) return { phase: "failed", reason: doc.error };
  if ("expired" in doc) return { phase: "expired" };
  if ("joined" in doc) return { phase: "joined", name: doc.joined.name };
  return undefined;
}

/**
 * While `open`, asks this host for a single-use mesh offer through the offer document and follows the document's events
 * on its own event feed until the host answers; a host that does not answer in {@link OFFER_ANSWER_MS} cannot make one.
 */
export function useJoinOffer(connection: HcConnection, open: boolean, client = false): JoinOffer {
  const [offer, setOffer] = useState<JoinOffer>({ phase: "asking" });
  useEffect(() => {
    if (!open) return;
    const calls = callsOf(connection);
    const request = crypto.randomUUID();
    let answered = false;
    let closed = false;
    setOffer({ phase: "asking" });
    const settle = (next: JoinOffer): void => {
      if (closed) return;
      answered = true;
      setOffer(next);
    };
    const read = async (): Promise<void> => {
      const answer = offerFor((await calls.get()).value, request);
      if (answer !== undefined) settle(answer);
    };
    let feed: EventFeed | undefined;
    const timer = setTimeout(() => {
      if (answered) return;
      settle({
        phase: "failed",
        reason:
          "This host did not answer. It may be older than this app: update doriface-host, or use the steps below.",
      });
    }, OFFER_ANSWER_MS);
    void (async () => {
      const subscribed = await connection.subscribe();
      if (closed) return subscribed.close();
      feed = subscribed;
      subscribed.onEvent((event) => {
        if (event.type === "doc" && event.machine === undefined && event.data.name === MESH_OFFER_DOC) {
          void read().catch(() => {});
        }
      });
      const { version } = await calls.get();
      await calls.set({ request, ...(client ? { client: true } : {}) }, version);
      await read();
    })().catch((error: unknown) =>
      settle({ phase: "failed", reason: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      closed = true;
      clearTimeout(timer);
      feed?.close();
    };
  }, [connection, open, client]);
  return offer;
}
