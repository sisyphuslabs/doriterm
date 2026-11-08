import { HcConnection } from "@doriface/client";
import { HcRpcError, type JsonValue, MESH_APPROVAL_DOC, MESH_OFFER_DOC, parseMeshOfferDoc } from "@doriface/protocol";
import { type Clock, monotonicClock } from "./clock.ts";
import { type ChildByteLink, type HcTarget, spawnHcLink } from "./hc-machines.ts";
import { answerMeshApproval, type MeshDecision } from "./approval-doc.ts";
import { docStoreOf } from "./status-doc.ts";

export const RETRY_MS = 5_000;

/** The service's two clocks, injectable so a test drives them. */
export interface MeshOfferTime {
  /** Wall time: an offer's `expiresAt` is a wall time, and a join is admitted while this is before it (join-dial). */
  readonly wallNow: () => number;
  /** Runs the expiry and reconnect timers. */
  readonly clock: Clock;
}

const systemTime: MeshOfferTime = { wallNow: () => Date.now(), clock: monotonicClock };

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
async function dropIfExpired(connection: HcConnection, now: number): Promise<void> {
  const doc = await connection.call("doc.get", { name: MESH_OFFER_DOC });
  const current = parseMeshOfferDoc(doc.value);
  if (current === undefined || !("link" in current) || current.expiresAt > now) return;
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
  open: (client: boolean) => Promise<MeshOffer>,
  openLink: (core: HcTarget) => OfferLink = spawnHcLink,
  time: MeshOfferTime = systemTime,
  decide?: MeshDecision,
): MeshOfferService {
  const first = Promise.withResolvers<void>();
  let stopped = false;
  let link: OfferLink | undefined;
  let linkOpen = false;
  let exited: Promise<void> = Promise.resolve();
  let cancelRetry: (() => void) | undefined;
  const expiries = new Set<() => void>();
  const follows = new Set<() => void>();
  let answering: string | undefined;
  // The line timers and joins write through: the one up now, so a reconnect does not strand them on a closed one.
  let live: HcConnection | undefined;

  const expire = (expiresAt: number, unfollow: () => void): void => {
    const cancel = time.clock.after(Math.max(0, expiresAt - time.wallNow()), () => {
      expiries.delete(cancel);
      // The wall clock stepped back since the timer was set: the offer still admits until expiresAt, so the link and
      // the join it may bring wait for that (#834).
      if (time.wallNow() < expiresAt) return expire(expiresAt, unfollow);
      unfollow();
      if (live !== undefined)
        void dropIfExpired(live, time.wallNow()).catch((error: unknown) =>
          log(`mesh offer: cannot drop the expired link: ${String(error)}`),
        );
    });
    expiries.add(cancel);
  };

  // A join waits here until it is written, so one admitted while the line is down is written on the next connect (#834).
  const joins = new Map<string, { readonly name: string; readonly hostId: string }>();
  const writeJoin = async (
    connection: HcConnection,
    request: string,
    joined: { readonly name: string; readonly hostId: string },
  ): Promise<void> => {
    const doc = await connection.call("doc.get", { name: MESH_OFFER_DOC });
    const current = parseMeshOfferDoc(doc.value);
    const owed = current?.request === request && !("joined" in current);
    // Lost to another write: its doc event brings the document back, and the join is written then.
    if (owed && !(await write(connection, { request, joined }, doc.version))) return;
    joins.delete(request);
  };
  // One after another: each write is made at the version the one before it left.
  const writeJoins = (connection: HcConnection): Promise<void> =>
    [...joins].reduce<Promise<void>>(
      (chain, [request, joined]) => chain.then(() => writeJoin(connection, request, joined)),
      Promise.resolve(),
    );

  // The offer admits once: the first join on it replaces the link with who joined, so the asking client can say so.
  // A join belongs to this offer when it shares the offer's expiry, which a pending join takes from the offer it came on.
  const follow = (request: string, expiresAt: number): (() => void) => {
    const stop = onAdmitted((join) => {
      if (join.expiresAt !== expiresAt) return;
      stop();
      follows.delete(stop);
      joins.set(request, { name: join.name, hostId: join.hostId });
      if (live !== undefined)
        void writeJoins(live).catch((error: unknown) => log(`mesh offer: cannot write the join: ${String(error)}`));
    });
    follows.add(stop);
    return () => {
      stop();
      follows.delete(stop);
    };
  };

  const answer = async (connection: HcConnection): Promise<void> => {
    // A join is written before the expiry is read: an offer that admitted a machine did not expire unused.
    await writeJoins(connection);
    await dropIfExpired(connection, time.wallNow());
    const doc = await connection.call("doc.get", { name: MESH_OFFER_DOC });
    const current = parseMeshOfferDoc(doc.value);
    if (
      current === undefined ||
      "link" in current ||
      "error" in current ||
      "expired" in current ||
      "joined" in current ||
      answering === current.request
    )
      return;
    const { request } = current;
    answering = request;
    try {
      const offer = await open(current.client === true);
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
    if (!stopped) cancelRetry = time.clock.after(RETRY_MS, () => void connect());
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
      const approve = (): void => {
        if (decide !== undefined)
          void answerMeshApproval(docStoreOf(connection), decide).catch((error: unknown) =>
            log(`mesh: cannot answer an approval: ${String(error)}`),
          );
      };
      feed.onEvent((event) => {
        if (event.type === "doc" && event.machine === undefined && event.data.name === MESH_OFFER_DOC) handle();
        if (event.type === "doc" && event.machine === undefined && event.data.name === MESH_APPROVAL_DOC) approve();
      });
      feed.onClose(() => {
        if (live === connection) live = undefined;
        connection.close();
        retry();
      });
      first.resolve();
      // A request written while the host was away is answered now.
      handle();
      approve();
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
      cancelRetry?.();
      for (const cancel of expiries) cancel();
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
