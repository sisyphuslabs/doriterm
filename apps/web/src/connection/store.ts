import type { HcConnection } from "@doriface/client";
import { useSyncExternalStore } from "react";
import type { HostStartFailure } from "../desktop/bridge.ts";
import { AttemptBudget, AttemptTimeoutError } from "./attempt-budget.ts";
import {
  connect,
  DeviceNotPairedError,
  LoopbackTokenError,
  type ConnectionPath,
  type OpenConnection,
} from "./connect.ts";
import type { DirectReason } from "./direct-attempt.ts";
import { helloName } from "./hello-name.ts";
import { isFinal } from "./host-failure.ts";
import { MeshConnections, type MemberEntry } from "./mesh-connections.ts";
import { type ResumeWiring, wireResume } from "./resume-wiring.ts";
import {
  type ConnectionSettings,
  isConfigured,
  loadSettings,
  lockRelay,
  normalizeSettings,
  type Saver,
  saveSettings,
  staysOnThisComputer,
} from "./settings.ts";
import { resumeOnWake, unprovenLinks } from "./wake.ts";
import { WakeProbe, type WakeProbing } from "./wake-probe.ts";

/**
 * `stale` is the connection that dropped while this one retries: its workspace stays on screen meanwhile.
 * It is null on the first connect, after a settings change and when retrying cannot help.
 */
export type ConnectionState =
  | { readonly phase: "unconfigured" }
  | { readonly phase: "connecting"; readonly attempt: number; readonly stale: HcConnection | null }
  | {
      readonly phase: "open";
      readonly connection: HcConnection;
      readonly path: ConnectionPath;
      readonly directReason?: DirectReason | undefined;
      /**
       * How long this attempt took to open the session, measured on this device from its start (#637). Absent when this
       * store did not dial the session itself (one pairing proved and handed over, #1271): no figure rather than a guess.
       */
      readonly connectMs?: number | undefined;
      /** A wake is asking this link to prove itself (#1370): input typed meanwhile waits rather than going into it. */
      readonly proving?: boolean | undefined;
      /**
       * The session's socket dropped and the session is being carried on over a new one (contract v1.11): the workspace
       * stays as it is, and input typed meanwhile waits for the new socket.
       */
      readonly resuming?: boolean | undefined;
      /** While resuming: why the last dial to carry the session on failed (a host gone answers 4404). */
      readonly resumeFailure?: Error | undefined;
    }
  /** This computer's host did not start: nothing is tried until a start succeeds. */
  | { readonly phase: "host-failed"; readonly failure: HostStartFailure }
  | {
      readonly phase: "failed";
      readonly settling?: boolean;
      readonly error: Error;
      readonly retryInMs: number | null;
      /** When the next attempt starts (Date.now() epoch ms), or null with retryInMs. */
      readonly retryAt: number | null;
      readonly stale: HcConnection | null;
    };

const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;

/**
 * How long a live connection has to stay up before its next drop starts the ladder over. A link that opens and drops must
 * keep backing off, or a flapping host reconnects on the shortest delay forever (#634); the comparable clients reset at a
 * floor of this order — 10 s in one, 60 s in herdr (`#653`).
 */
const STABLE_CONNECTION_MS = 10_000;

/** This computer's host, as the desktop app runs it: where it listens now, and why it did not start. */
export interface LocalHostStarter {
  start(): Promise<{ readonly url: string; readonly token: string }>;
  failure(cause: unknown): HostStartFailure;
}

/** Owns the one live connection: connects, reconnects with backoff, and reports its state. */
export class ConnectionStore {
  #settings: ConnectionSettings;
  #state: ConnectionState = { phase: "unconfigured" };
  #listeners = new Set<() => void>();
  #abort: AbortController | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stale: HcConnection | null = null;
  /** The attempt the pending retry timer will make, so `retryNow` can make it at once. */
  #pending: number | null = null;
  /** The next attempt goes to the relay at once: the one before it was a direct link that dropped (#446 §4). */
  #relayFirst = false;
  /** Asked before each retry of a loopback link: this computer's host, started again if it died (the desktop app). */
  #localHost: LocalHostStarter | null = null;
  /** The live connection has been up past {@link STABLE_CONNECTION_MS}, so its next drop starts the ladder over. */
  #stable = false;
  #stableTimer: ReturnType<typeof setTimeout> | undefined;
  /** The attempt in flight, so a wake starts a fresh one instead of waiting for it. */
  #current = 0;
  /** A wake already asked for this tick: several page events must cost one attempt, not three. */
  #wakeQueued = false;
  /**
   * Why the store closed its connection itself. {@link stop} clears it, and is its one guard: every path that opens
   * another connection runs it first, so no other connection's drop can take this reason (#2044).
   */
  #closedFor: Error | null = null;
  readonly #budget = new AttemptBudget();
  readonly #connect: typeof connect;
  readonly #save: Saver;
  /** A wake's check on the open link: a socket the page slept on can be half-open (#653), and input must not go into it. */
  readonly #wake: WakeProbe;
  /** The open connection's session resume, when its path has a session to carry on (contract v1.11). */
  #resume: ResumeWiring | null = null;
  readonly #links: typeof unprovenLinks;
  readonly #now: () => number;

  /**
   * `save` is how this store records a change to its settings. A store that owns the saved settings writes them itself; one that
   * is a single member of a mesh (`mesh-connections.ts`) passes a no-op, because its settings are a slice of a roster another
   * object owns, and writing that slice back would replace the roster with it. `now` times an attempt's open (`connectMs`): a
   * monotonic clock, like the round trip beside it, so a wall clock stepped mid-attempt (NTP, sleep) cannot skew it (#1234).
   */
  constructor(
    settings: ConnectionSettings,
    open: typeof connect = connect,
    save: Saver = saveSettings,
    probing: WakeProbing = {},
    now: () => number = () => performance.now(),
  ) {
    this.#settings = lockRelay(settings);
    this.#connect = open;
    this.#save = save;
    this.#wake = new WakeProbe(probing);
    this.#links = probing.links ?? unprovenLinks;
    this.#now = now;
  }

  get settings(): ConnectionSettings {
    return this.#settings;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Saves and connects with `settings`; a release build keeps the production relay whatever relay they name. */
  update(settings: ConnectionSettings): void {
    const locked = lockRelay(settings);
    const sameHost = locked.hostId === this.#settings.hostId;
    // A name belongs to the host that said it: another paired host starts without one, and its own hello fills it in.
    const cleared = sameHost ? locked : { ...locked, hostName: "" };
    // Pairing REPLACES the host this app is bound to; it does not quietly keep the one the user paired away from, or every
    // later failure alternates the attempt onto a host that is gone and saves that as the selection (review of #994). A mesh
    // join is what ADDS a member, and that path does not come through here.
    const replaced = sameHost ? cleared : { ...cleared, members: [] };
    // The file and what the app keeps in memory obey the same roster rule, or pairing shows one list and saves another.
    this.#settings = normalizeSettings(replaced);
    this.#save(this.#settings);
    this.start();
  }

  /** Shows the connecting state while the desktop app restarts its local host before the first attempt. */
  restoring(): void {
    this.stop();
    this.#set({ phase: "connecting", attempt: 0, stale: null });
  }

  /**
   * In the desktop app a loopback link is to this computer's own host. When that link fails and is tried again, the
   * host is asked for first: it answers at once while it runs, and starts again (on a new port, with a new token) if
   * it died, so the retry reaches a host that is there instead of the one that is gone (#515).
   */
  restartsLocalHost(starter: LocalHostStarter): void {
    this.#localHost = starter;
  }

  /** The desktop app's local host did not start at boot: its cause is shown and the saved link is not tried. */
  hostStartFailed(failure: HostStartFailure): void {
    this.stop();
    this.#set({ phase: "host-failed", failure });
  }

  start(): void {
    this.stop();
    this.#relayFirst = false;
    if (!isConfigured(this.#settings)) {
      this.#set({ phase: "unconfigured" });
      return;
    }
    void this.#attempt(0);
  }

  stop(): void {
    this.#wake.stop();
    this.#resume?.stop();
    this.#resume = null;
    this.#closedFor = null;
    clearTimeout(this.#timer);
    clearTimeout(this.#stableTimer);
    this.#stable = false;
    this.#pending = null;
    this.#abort?.abort();
    this.#abort = null;
    this.#stale = null;
    if (this.#state.phase === "open") this.#state.connection.close();
  }

  async #attempt(attempt: number): Promise<void> {
    this.#current = attempt;
    if (this.#offline()) return this.#hold(attempt);
    const abort = new AbortController();
    this.#abort = abort;
    const relayFirst = this.#relayFirst;
    this.#relayFirst = false;
    this.#set({ phase: "connecting", attempt, stale: this.#stale });
    const started = this.#now();
    try {
      const opened: OpenConnection = await this.#budget.bounded(
        this.#connect(this.#settings, abort.signal, undefined, relayFirst ? { skipDirect: true } : {}),
        abort,
      );
      if (abort.signal.aborted) return opened.connection.close();
      this.#opened(opened, abort, attempt, this.#now() - started);
    } catch (error) {
      if (this.#abort !== abort) return;
      if (error instanceof AttemptTimeoutError) {
        this.#budget.timedOut();
        this.#retry(error, attempt + 1);
        return;
      }
      if (abort.signal.aborted) return;
      this.#retry(error instanceof Error ? error : new Error(String(error)), attempt + 1);
    }
  }

  /**
   * Takes a session that is already open as this store's connection, as a dial that just succeeded: pairing proves one,
   * and dialing again for the workspace cost a relay socket, a Noise handshake and a hello more (#1271). A drop then
   * reconnects as any other drop does.
   */
  adopt(opened: OpenConnection, settings?: ConnectionSettings): void {
    this.stop();
    if (settings !== undefined) this.#settings = lockRelay(settings);
    this.#relayFirst = false;
    const abort = new AbortController();
    this.#abort = abort;
    this.#current = 0;
    this.#opened(opened, abort, 0);
  }

  /** A connection this store now runs on: named, watched for its drop, and shown open with its open time when measured. */
  #opened(opened: OpenConnection, abort: AbortController, attempt: number, connectMs?: number): void {
    const { connection } = opened;
    this.#rememberName(connection);
    this.#resume = wireResume(opened, {
      resuming: (on) => {
        const state = this.#state;
        if (state.phase === "open" && state.connection === connection)
          this.#set({ ...state, resuming: on, resumeFailure: undefined });
      },
      failed: (error) => {
        const state = this.#state;
        if (state.phase === "open" && state.connection === connection && state.resuming === true)
          this.#set({ ...state, resumeFailure: error });
      },
      links: this.#links,
    });
    connection.onClose((error) => {
      if (this.#abort !== abort) return;
      this.#resume?.stop();
      this.#resume = null;
      if (opened.path === "direct") this.#relayFirst = true;
      this.#stale = connection;
      const closedFor = this.#closedFor;
      this.#closedFor = null;
      const reason = error ?? closedFor ?? new Error("the host closed the connection");
      this.#retry(reason, this.#stable ? 0 : attempt + 1);
    });
    this.#stale = null;
    this.#budget.reset();
    this.#armStable();
    this.#set({
      phase: "open",
      connection,
      path: opened.path,
      ...(opened.directReason === undefined ? {} : { directReason: opened.directReason }),
      ...(connectMs === undefined ? {} : { connectMs }),
    });
  }

  /**
   * Moves the selection to the next member of the roster, when there is one to move to.
   *
   * The roster is what the saved settings carry; with one member this does nothing, so a single-host app behaves exactly as
   * it did. Each rotation is saved, because the host this app is bound to is then the one it is reaching for.
   */
  #rotateMember(): void {
    const { members } = this.#settings;
    if (members.length < 2) return;
    const at = members.findIndex((member) => member.hostId === this.#settings.hostId);
    // A selected host that is not in the roster cannot be moved on from: the roster rule puts it there, so its absence means
    // the two disagree, and picking members[0] would bind the app to a host nobody selected.
    if (at === -1) return;
    const next = members[(at + 1) % members.length];
    if (next === undefined || next.hostId === this.#settings.hostId) return;
    this.#settings = {
      ...this.#settings,
      hostId: next.hostId,
      hostName: next.hostName,
      hostKey: next.hostKey,
      directUrl: next.directUrl,
    };
    this.#save(this.#settings);
  }

  /**
   * The live connection has proved itself once it stays up for {@link STABLE_CONNECTION_MS}: from then on a drop starts
   * the ladder at its shortest delay. Anything shorter keeps the count a link has already earned.
   */
  #armStable(): void {
    clearTimeout(this.#stableTimer);
    this.#stable = false;
    this.#stableTimer = setTimeout(() => {
      this.#stable = true;
    }, STABLE_CONNECTION_MS);
  }

  #disarmStable(): void {
    clearTimeout(this.#stableTimer);
    this.#stable = false;
  }

  /** Whether there is no network to try on, and the link would need one: a link to this computer does not. */
  #offline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine === false && !staysOnThisComputer(this.#settings);
  }

  /** No network to try on: keep the waiting state and its countdown, and dial nothing (#636). */
  #hold(attempt: number): void {
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 10_000;
    this.#set({
      phase: "failed",
      error: new Error("No network. Reconnects when the network is back."),
      retryInMs: delay,
      retryAt: Date.now() + delay,
      stale: this.#stale,
    });
    this.#wait(attempt);
  }

  /** Arms `attempt` for its own delay without dialing anything. */
  #wait(attempt: number): void {
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 10_000;
    clearTimeout(this.#timer);
    this.#pending = attempt;
    this.#timer = setTimeout(() => {
      this.#pending = null;
      void this.#again(attempt);
    }, delay);
  }

  /**
   * A host names itself as it answers, and that name is the only way Settings can name it once it stops answering: keep
   * it beside the paired host while it is known (#496). A connection that carried no hello names nothing, and a session
   * must not fail over a name it could not read: Settings shows the host by id instead.
   */
  #rememberName(connection: HcConnection): void {
    const name = helloName(connection);
    if (name === "" || name === this.#settings.hostName) return;
    this.#settings = { ...this.#settings, hostName: name };
    this.#save(this.#settings);
  }

  #retry(error: Error, attempt: number): void {
    this.#disarmStable();
    const settling =
      this.#settings.viewMember === true &&
      (error instanceof DeviceNotPairedError || ("code" in error && error.code === 4401));
    // The desktop app's own host is asked for its current token before each retry (#515), so a refused one is not final.
    const asksForToken = error instanceof LoopbackTokenError && this.#localHost !== null;
    if (isFinal(error) && !settling && !asksForToken) {
      this.#stale = null;
      this.#set({ phase: "failed", error, retryInMs: null, retryAt: null, stale: null });
      return;
    }
    // One host stopping must not end the app: the next attempt asks the next member this app knows (design of #942).
    // This is the single place a retry is decided, so it covers a failed attempt AND a live link that dropped. It runs only
    // after the final-error check, so a failure no retry can help never moves the selection out from under the message the
    // user is reading, and never in loopback mode, where the address is this computer's own gateway rather than a member
    // (review of #994).
    if (this.#settings.mode !== "loopback") this.#rotateMember();
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 10_000;
    this.#set({
      phase: "failed",
      error: settling ? new Error("Settling: waiting for this machine to learn this browser's membership.") : error,
      ...(settling ? { settling: true } : {}),
      retryInMs: delay,
      retryAt: Date.now() + delay,
      stale: this.#stale,
    });
    this.#wait(attempt);
  }

  /** A retry: for a loopback link in the desktop app, this computer's host first, then the link to where it is now. */
  async #again(attempt: number): Promise<void> {
    const starter = this.#localHost;
    if (starter === null || this.#settings.mode !== "loopback") return this.#attempt(attempt);
    const asked = this.#settings;
    const abort = new AbortController();
    this.#abort = abort;
    this.#set({ phase: "connecting", attempt, stale: this.#stale });
    let where: { readonly url: string; readonly token: string };
    try {
      where = await starter.start();
    } catch (cause) {
      if (abort.signal.aborted || this.#settings !== asked) return undefined;
      this.#stale = null;
      return this.#set({ phase: "host-failed", failure: starter.failure(cause) });
    }
    if (abort.signal.aborted || this.#settings !== asked) return undefined;
    if (where.url !== asked.loopbackUrl || where.token !== asked.token) {
      this.#settings = { ...asked, loopbackUrl: where.url, token: where.token };
      this.#save(this.#settings);
    }
    return this.#attempt(attempt);
  }

  /**
   * Makes a waiting retry now instead of at the end of its back-off (the page can work again), or replaces an attempt
   * already in flight; the workspace stays (#636).
   */
  retryNow(): void {
    if (this.#state.phase === "connecting") return this.#restart();
    // A session being carried on dials again now; one that is not is checked.
    if (this.#state.phase === "open" && this.#resume?.resumer.active === true) return this.#resume.resumer.now();
    if (this.#state.phase === "open") return this.#probe(this.#state.connection);
    const attempt = this.#pending;
    if (attempt === null || this.#state.phase !== "failed") return;
    clearTimeout(this.#timer);
    this.#pending = null;
    void this.#again(attempt);
  }

  /**
   * Abandons the attempt in flight and dials again at once: after a wake, the socket that was opening before the page
   * slept may be half-open, and waiting for it would cost the whole attempt's deadline. One wake per tick is enough.
   */
  #restart(): void {
    if (this.#abort === null || this.#wakeQueued) return;
    this.#wakeQueued = true;
    queueMicrotask(() => {
      this.#wakeQueued = false;
      if (this.#state.phase !== "connecting") return;
      this.#budget.reset();
      this.#abort?.abort();
      void this.#again(this.#current);
    });
  }

  /**
   * Checks the open link (see WakeProbe): the open state says so while the check is out, and a check that goes unanswered
   * closes the link, so the drop reconnects as any other drop does.
   */
  #probe(connection: HcConnection): void {
    this.#wake.ask(
      connection,
      (proving) => {
        const state = this.#state;
        if (state.phase === "open" && state.connection === connection) this.#set({ ...state, proving });
      },
      (reason) => {
        if (this.#state.phase !== "open" || this.#state.connection !== connection) return;
        // A session that can be carried on takes the loss and dials again; any other link is closed and reconnected.
        if (this.#resume?.lost(reason) === true) return;
        this.#closedFor = reason;
        connection.close();
      },
    );
  }

  #set(state: ConnectionState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

export const connectionStore = new MeshConnections(
  loadSettings(),
  (settings, save) => new ConnectionStore(settings, connect, save),
);

// The page can work again: the network returned, a page came back from the cache, or a tab became visible (#653).
resumeOnWake(connectionStore);

export function useConnection(store: Pick<MeshConnections, "subscribe" | "state"> = connectionStore): ConnectionState {
  return useSyncExternalStore(
    store.subscribe,
    () => store.state,
    () => store.state,
  );
}

/** The saved connection settings, drawn again whenever they change: a view that reads them subscribes here (#813). */
export function useConnectionSettings(): ConnectionSettings {
  return useSyncExternalStore(connectionStore.subscribe, () => connectionStore.settings);
}

/** Every member and its own connection state, for a list that marks one machine offline rather than the whole app. */
export function useMeshMembers(): readonly MemberEntry[] {
  return useSyncExternalStore(connectionStore.subscribe, () => connectionStore.entries());
}
