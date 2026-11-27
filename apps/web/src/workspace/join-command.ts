import type { EventFeed, HcConnection } from "@doriface/client";
import { DEFAULT_PAIRING_WEB_ORIGIN } from "@doriface/crypto";
import { HcRpcError, MESH_OFFER_DOC, parseMeshOfferDoc } from "@doriface/protocol";
import { useEffect, useRef, useState } from "react";

/** get.doriterm.com answers curl with the stable channel's install.sh, and GitHub's when it is not mirrored (#1969). */
export const INSTALL_SCRIPT_URL = "https://get.doriterm.com";

/** How long a host gets to answer before the dialog says it cannot make a join command (a host older than #668). */
export const OFFER_ANSWER_MS = 15_000;

/** The longest wait before following the offer again after a feed ended or a subscribe failed (#1780). */
export const REFOLLOW_MAX_MS = 5_000;

/** A feed that lived this long counts as followed: the next one that ends is opened again at once (#1780). */
export const FOLLOWED_MS = 5_000;

/** The wait before following again after `failures` ends in a row: at once the first time, then 250 ms doubling. */
export const refollowMs = (failures: number): number =>
  failures === 0 ? 0 : Math.min(REFOLLOW_MAX_MS, 250 * 2 ** (failures - 1));

/**
 * The invite as a link a phone or browser opens: this app's own page when it is served over https, the hosted app
 * otherwise (the desktop app's own scheme is no page a phone can open, #2939). The secret stays in the fragment.
 */
export function webInviteLink(link: string, origin: string = location.origin): string {
  const hash = link.slice(link.indexOf("#"));
  return `${origin.startsWith("https:") ? origin : DEFAULT_PAIRING_WEB_ORIGIN}/pair${hash}`;
}

/**
 * The one line to run on the machine to add: install (or update) the host as a service, then join this mesh. The link
 * reaches the installer in its environment (DORIFACE_JOIN), which only the same user (and root) can read, never on a command line.
 */
export function joinCommand(link: string): string {
  return `curl -fsSL ${INSTALL_SCRIPT_URL} | DORIFACE_JOIN='${link.replaceAll("'", "'\\''")}' sh`;
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
  if ("link" in doc)
    return { phase: "ready", command: joinCommand(doc.link), link: doc.link, expiresAt: doc.expiresAt };
  if ("error" in doc) return { phase: "failed", reason: doc.error };
  if ("expired" in doc) return { phase: "expired" };
  if ("joined" in doc) return { phase: "joined", name: doc.joined.name };
  return undefined;
}

/**
 * Re-read the offer on its doc event or when missed events are replaced by a snapshot without documents; a feed that
 * ends for any reason but the dialog's own close is opened again (`reopen`), so a join is never missed (#1780).
 */
export function followJoinOffer(feed: EventFeed, read: () => void, reopen?: () => void): void {
  // onEvent drains queued deliveries, including snapshots received before the listener was installed.
  feed.onSnapshot(read);
  feed.onEvent((event) => {
    if (event.type === "doc" && event.machine === undefined && event.data.name === MESH_OFFER_DOC) read();
  });
  feed.onClose((close) => {
    if (close.reason !== "detached") reopen?.();
  });
}

/** How many times a request lost to another writer of the offer document is written again on a fresh read. */
const ASK_ATTEMPTS = 5;

/**
 * Writes this request at the version the document has now. Another writer can land between the read and the write (a
 * sheet that asked for a phone, then for a computer, #2939), and the core refuses that write as a `conflict`: it is
 * read and written again, a few times, and any other failure is thrown as it came. A request whose dialog or tab is gone
 * (`closed`) writes nothing more, so it never overwrites the request that replaced it.
 */
export async function askOnce(
  calls: Pick<ReturnType<typeof callsOf>, "get" | "set">,
  value: Parameters<ReturnType<typeof callsOf>["set"]>[0],
  closed: () => boolean,
  attempt = 1,
): Promise<void> {
  if (closed()) return;
  const { version } = await calls.get();
  if (closed()) return;
  try {
    await calls.set(value, version);
  } catch (error) {
    if (attempt >= ASK_ATTEMPTS || !(error instanceof HcRpcError && error.kind === "conflict")) throw error;
    await askOnce(calls, value, closed, attempt + 1);
  }
}

/**
 * While `open`, asks this host for a single-use mesh offer through the offer document and follows the document's events
 * on its own event feed until the host answers; a host that does not answer in {@link OFFER_ANSWER_MS} cannot make one.
 * The request lasts while the dialog is open: a new connection reads it back before asking again, so a join the host
 * took on a connection that dropped still shows (#1780).
 */
export function useJoinOffer(connection: HcConnection, open: boolean, client = false): JoinOffer {
  const [offer, setOffer] = useState<JoinOffer>({ phase: "asking" });
  const asked = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!open) {
      asked.current = undefined;
      return;
    }
    const calls = callsOf(connection);
    const request = asked.current ?? crypto.randomUUID();
    const fresh = asked.current === undefined;
    asked.current = request;
    let answered = false;
    let closed = false;
    // A new connection asks again: a "did not answer" from the one before is not the new one's answer.
    if (fresh) setOffer({ phase: "asking" });
    else setOffer((shown) => (shown.phase === "failed" ? { phase: "asking" } : shown));
    const settle = (next: JoinOffer): void => {
      if (closed) return;
      answered = true;
      setOffer(next);
    };
    const read = async (): Promise<boolean> => {
      const answer = offerFor((await calls.get()).value, request);
      if (answer !== undefined) settle(answer);
      return answer !== undefined;
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
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let reread: ReturnType<typeof setTimeout> | undefined;
    // The read after following again is what finds a join written while no feed was open: one that fails is tried
    // again on the same backoff, on the feed it has, until one is answered or the dialog closes.
    const readAfterFollow = (attempt: number): void => {
      // One reread chain at a time: a newer follow replaces a pending reread, so cleanup always holds the only timer.
      clearTimeout(reread);
      void read().catch(() => {
        // A connection that closed is replaced as a whole, which runs this effect again: it is not read meanwhile.
        if (closed || connection.closed) return;
        reread = setTimeout(() => readAfterFollow(attempt + 1), refollowMs(attempt + 1));
      });
    };
    // A failed subscribe is tried again; a failed read after it is read again, without a new feed.
    const followAndRead = (): void =>
      void follow().then(
        () => readAfterFollow(0),
        () => refollow(false),
      );
    const follow = async (): Promise<void> => {
      const subscribed = await connection.subscribe();
      if (closed) return subscribed.close();
      feed = subscribed;
      const since = Date.now();
      followJoinOffer(
        subscribed,
        () => void read().catch(() => {}),
        () => refollow(Date.now() - since >= FOLLOWED_MS),
      );
    };
    // Follows the offer again on this connection, at once or after a backoff, and reads it so a join written while no
    // feed was open still shows; a connection that closed is replaced as a whole, which runs this effect again.
    const refollow = (lived: boolean): void => {
      if (closed || connection.closed) return;
      failures = lived ? 0 : failures;
      const wait = refollowMs(failures);
      failures += 1;
      if (wait === 0) followAndRead();
      else retry = setTimeout(followAndRead, wait);
    };
    void (async () => {
      await follow();
      if (closed || (!fresh && (await read()))) return;
      await askOnce(calls, { request, ...(client ? { client: true } : {}) }, () => closed);
      await read();
    })().catch((error: unknown) =>
      settle({ phase: "failed", reason: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(retry);
      clearTimeout(reread);
      feed?.close();
    };
  }, [connection, open, client]);
  return offer;
}
