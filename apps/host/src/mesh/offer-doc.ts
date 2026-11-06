import { HcConnection } from "@doriface/client";
import { HcRpcError, type JsonValue, MESH_OFFER_DOC, parseMeshOfferDoc } from "@doriface/protocol";
import { type ChildByteLink, type HcTarget, spawnHcLink } from "./hc-machines.ts";

const RETRY_MS = 5_000;

export interface MeshOffer {
  /** The mesh link `doriface-host mesh join` takes. */
  readonly link: string;
  readonly expiresAt: number;
}

export interface MeshOfferService {
  /** Settles once the first subscription is up (or the first attempt failed and a retry is due). */
  readonly ready: Promise<void>;
  stop(): Promise<void>;
  /** Kills the service's `hc connect` child if it has not exited, and returns the pids it killed. */
  kill(): readonly number[];
}

type OfferLink = ChildByteLink;

async function write(connection: HcConnection, value: JsonValue, version: number): Promise<boolean> {
  try {
    await connection.call("doc.set", { name: MESH_OFFER_DOC, value, version });
    return true;
  } catch (error) {
    // Another write came first: its own doc event brings the document back here.
    if (error instanceof HcRpcError && error.kind === "conflict") return false;
    throw error;
  }
}

// An answered link whose offer has expired becomes `expired`; read on every connect and doc event too, so a timer
// lost with its connection or its host still ends with the link gone.
async function dropIfExpired(connection: HcConnection): Promise<void> {
  const doc = await connection.call("doc.get", { name: MESH_OFFER_DOC });
  const current = parseMeshOfferDoc(doc.value);
  if (current === undefined || !("link" in current) || current.expiresAt > Date.now()) return;
  await write(connection, { request: current.request, expired: true }, doc.version);
}

/**
 * Answers a client's one-line Add a machine (#668): a `{request}` in the `doriface-mesh-offer` document opens one
 * single-use mesh offer that admits without asking, written back beside the request; the link is dropped from the
 * document once the offer expires, so it does not outlive its use there. A request already answered is left alone, so
 * the host's own write (a doc event too) opens nothing. Anyone who can write this core's documents already reaches its
 * shells, so the request grants no more than they hold.
 */
export function serveMeshOffers(
  target: HcTarget,
  log: (line: string) => void,
  onAdmitted: (
    listener: (join: { readonly name: string; readonly hostId: string; readonly expiresAt: number }) => void,
  ) => () => void,
  open: () => Promise<MeshOffer>,
  openLink: (core: HcTarget) => OfferLink = spawnHcLink,
): MeshOfferService {
  const first = Promise.withResolvers<void>();
  let stopped = false;
  let link: OfferLink | undefined;
  let linkOpen = false;
  let exited: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const expiries = new Set<ReturnType<typeof setTimeout>>();
  const follows = new Set<() => void>();
  let answering: string | undefined;
  // The line timers and joins write through: the one up now, so a reconnect does not strand them on a closed one.
  let live: HcConnection | undefined;

  const expire = (expiresAt: number, unfollow: () => void): void => {
    const timer = setTimeout(
      () => {
        expiries.delete(timer);
        unfollow();
        if (live !== undefined)
          void dropIfExpired(live).catch((error: unknown) =>
            log(`mesh offer: cannot drop the expired link: ${String(error)}`),
          );
      },
      Math.max(0, expiresAt - Date.now()),
    );
    expiries.add(timer);
  };

  // The offer admits once: the first join on it replaces the link with who joined, so the asking client can say so.
  // A join belongs to this offer when it shares the offer's expiry, which a pending join takes from the offer it came on.
  const follow = (request: string, expiresAt: number): (() => void) => {
    const stop = onAdmitted((join) => {
      if (join.expiresAt !== expiresAt) return;
      stop();
      follows.delete(stop);
      const connection = live;
      if (connection === undefined) return;
      void (async () => {
        const doc = await connection.call("doc.get", { name: MESH_OFFER_DOC });
        if (parseMeshOfferDoc(doc.value)?.request !== request) return;
        await write(connection, { request, joined: { name: join.name, hostId: join.hostId } }, doc.version);
      })().catch((error: unknown) => log(`mesh offer: cannot write the join: ${String(error)}`));
    });
    follows.add(stop);
    return () => {
      stop();
      follows.delete(stop);
    };
  };

  const answer = async (connection: HcConnection): Promise<void> => {
    await dropIfExpired(connection);
    const doc = await connection.call("doc.get", { name: MESH_OFFER_DOC });
    const current = parseMeshOfferDoc(doc.value);
    if (current === undefined || Object.keys(current).length > 1 || answering === current.request) return;
    const { request } = current;
    answering = request;
    try {
      const offer = await open();
      // Followed before the link is out: a machine can join the moment a client reads it.
      const unfollow = follow(request, offer.expiresAt);
      if (await write(connection, { request, link: offer.link, expiresAt: offer.expiresAt }, doc.version)) {
        log(`mesh offer: opened a single-use join for request ${request}`);
        expire(offer.expiresAt, unfollow);
      } else {
        unfollow();
      }
    } catch (error) {
      await write(connection, { request, error: error instanceof Error ? error.message : String(error) }, doc.version);
    } finally {
      answering = undefined;
    }
  };

  const retry = (): void => {
    if (!stopped) retryTimer = setTimeout(() => void connect(), RETRY_MS);
  };

  const connect = async (): Promise<void> => {
    const child = openLink(target);
    const gone = Promise.withResolvers<void>();
    child.onClose(() => {
      if (link === child) linkOpen = false;
      gone.resolve();
    });
    link = child;
    linkOpen = true;
    exited = gone.promise;
    try {
      const connection = await HcConnection.open(child);
      if (stopped) return connection.close();
      const feed = await connection.subscribe();
      live = connection;
      const handle = (): void =>
        void answer(connection).catch((error: unknown) => log(`mesh offer: cannot answer a request: ${String(error)}`));
      feed.onEvent((event) => {
        if (event.type === "doc" && event.machine === undefined && event.data.name === MESH_OFFER_DOC) handle();
      });
      feed.onClose(() => {
        if (live === connection) live = undefined;
        connection.close();
        retry();
      });
      first.resolve();
      // A request written while the host was away is answered now.
      handle();
    } catch (error) {
      child.close();
      if (stopped) return;
      log(`mesh offer: cannot follow this host's core: ${String(error)}`);
      first.resolve();
      retry();
    }
  };
  void connect();

  return {
    ready: first.promise,
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      for (const timer of expiries) clearTimeout(timer);
      expiries.clear();
      for (const stop of follows) stop();
      follows.clear();
      link?.close();
      first.resolve();
      return exited;
    },
    kill() {
      if (link?.kill === undefined || link.pid === undefined || !linkOpen) return [];
      link.kill("SIGKILL");
      return [link.pid];
    },
  };
}
