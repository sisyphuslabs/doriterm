import type { OpenConnection } from "./connect.ts";
import type { ConnectionState } from "./store.ts";
import type { HostStartFailure } from "../desktop/bridge.ts";
import type { LocalHostStarter } from "./store.ts";
import type { ConnectionSettings, MemberTarget, Saver } from "./settings.ts";
import { normalizeSettings, saveSettings } from "./settings.ts";
import { failOverTo, placeInAddress, withoutShownMachine } from "./failover.ts";

/**
 * What the mesh needs from one member's connection. `ConnectionStore` satisfies it structurally; declaring it here keeps this
 * module free of a runtime import back into the store, so the two never form an import cycle.
 */
export interface MemberConnection {
  readonly settings: ConnectionSettings;
  readonly state: ConnectionState;
  subscribe(listener: () => void): () => void;
  start(): void;
  /** Runs on a session that is already open instead of dialing one; `settings`, when given, replace its own first. */
  adopt(opened: OpenConnection, settings?: ConnectionSettings): void;
  stop(): void;
  retryNow(): void;
  update(settings: ConnectionSettings): void;
  restoring(): void;
  restartsLocalHost(starter: LocalHostStarter): void;
  hostStartFailed(failure: HostStartFailure): void;
}

export type StoreFactory = (settings: ConnectionSettings, save: Saver) => MemberConnection;

/** One member and the connection this app holds to it, which is independent of every other member's. */
export interface MemberEntry {
  readonly target: MemberTarget;
  readonly state: ConnectionState;
  readonly lastSeen?: number | undefined;
}

/** The one object `state` answers with when there is no connection to show: a fresh one per read would loop any rendering store. */
const UNSET: ConnectionState = { phase: "unconfigured" };

/** Whether a member's dial settings are unchanged, so an edit elsewhere does not tear down a connection it does not concern. */
const sameTarget = (held: ConnectionSettings, want: ConnectionSettings): boolean =>
  held.mode === want.mode &&
  held.relayUrl === want.relayUrl &&
  held.hostId === want.hostId &&
  held.hostName === want.hostName &&
  held.hostKey === want.hostKey &&
  held.viewMember === want.viewMember &&
  held.directUrl === want.directUrl &&
  held.loopbackUrl === want.loopbackUrl &&
  held.token === want.token;

/**
 * One connection per member, so a machine going away removes that machine and nothing else.
 *
 * Before this, the app held a single connection and, when it failed, moved the selection to the next member and dialled again:
 * one machine stopping meant every session this app had died with it, which is the behaviour Q reported ("if Air turns off,
 * everything turns off"). Here every member of the roster gets its own connection and its own retry ladder, so the others are
 * untouched when one host stops.
 *
 * A member's store is dialled with a roster of just itself. Rotation inside a store exists for the single-connection case, and
 * a per-member store that rotated would dial a member that already has its own connection; with a one-entry roster that code
 * cannot move at all.
 */
export class MeshConnections {
  #settings: ConnectionSettings;
  #view: readonly MemberTarget[] = [];
  #selection: string | undefined;
  #visibleSettings: ConnectionSettings | undefined;
  readonly #make: StoreFactory;
  readonly #stores = new Map<string, MemberConnection>();
  readonly #targets = new Map<string, MemberTarget>();
  readonly #lastSeen = new Map<string, number>();
  readonly #holdsPlace: () => boolean;
  /** The machine the person picked in this session: a failover never moves off it (#2532). Held here only, never saved. */
  #picked: string | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribes = new Map<string, () => void>();
  /**
   * The desktop app's own-host starter, kept here rather than handed to one connection.
   *
   * A fresh install has no member yet when the app registers it, and every connection built afterwards (a pairing, a roster
   * change) needs it too; forwarding it to whatever happened to exist at boot lost it for all of them (review of #994).
   */
  #localHost: LocalHostStarter | null = null;
  /**
   * Whether this app is dialling at all.
   *
   * Nothing is dialled when the settings are merely read: the boot path decides, because in the desktop app it must stop a stale
   * saved port before the saved link is tried, and because starting here made every member dial twice (review of #994).
   */
  #running = false;
  /** The members that have been handed to `start()`, so a settings change dials a store that never started and leaves an open one alone. */
  readonly #started = new Set<string>();
  /**
   * The list `entries()` answers with. Rebuilt only when something changes, because it is read through
   * `useSyncExternalStore`, which compares snapshots by identity and would re-render forever on a fresh array per call.
   */
  #snapshot: readonly MemberEntry[] = [];

  constructor(settings: ConnectionSettings, make: StoreFactory, holdsPlace: () => boolean = () => placeInAddress()) {
    this.#settings = normalizeSettings(settings);
    this.#make = make;
    this.#holdsPlace = holdsPlace;
    this.#sync();
    this.#refresh();
  }

  get settings(): ConnectionSettings {
    return this.#visibleSettings ?? this.#settings;
  }

  /** The selected member's connection, which is the one the workspace shows: the saved selection, or the first member. */
  get selected(): MemberConnection | undefined {
    const chosen = this.#stores.get(this.#selection ?? this.#settings.hostId);
    if (chosen !== undefined) return chosen;
    // A saved selection the roster does not hold cannot be dialled, and reporting it as unset would make every screen read "not
    // connected" while members are up. The first member answers for it until the person picks another.
    return this.#stores.values().next().value;
  }

  get state(): ConnectionState {
    return this.selected?.state ?? UNSET;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Every member and its own connection state, for a list that marks one machine offline instead of the whole app. */
  entries(): readonly MemberEntry[] {
    return this.#snapshot;
  }

  /** Verified view targets are ephemeral: only the bundle persists them, never the pairing settings. */
  setViewMembers(members: readonly MemberTarget[]): void {
    this.#view = members.map((member) => ({ ...member, directUrl: "" }));
    this.#sync();
    if (this.#selection !== undefined && !this.#targets.has(this.#selection)) this.#selection = undefined;
    if (this.#running) this.#startAll();
    this.#notify();
  }

  /** Takes new settings and keeps the roster: an edit to how this app dials, not a choice of what it dials. */
  update(settings: ConnectionSettings): void {
    this.#apply(withoutShownMachine(settings, this.#settings, this.#selection), undefined, true);
  }

  /**
   * Applies the fields a form changed to the settings as they are now, rather than a copy the form read when it opened:
   * the shown machine and the roster move on their own meanwhile, and a stale copy would restore them (#1006).
   */
  edit(fields: Partial<ConnectionSettings>): void {
    this.#apply({ ...this.#settings, ...fields }, undefined, true);
  }

  /**
   * Pairs with one machine, which ADDS it to what this app reaches.
   *
   * One phone reaches several computers: a machine paired earlier stays in the roster until it is removed on purpose, and
   * removal is its own act rather than a side effect of pairing again (#942).
   */
  pair(settings: ConnectionSettings, opened?: OpenConnection): void {
    // The name belongs to the host that said it (#496), so the machine just paired starts without one and its own hello
    // fills it in.
    const roster = [
      ...this.#settings.members.filter((member) => member.hostId !== settings.hostId),
      {
        hostId: settings.hostId,
        hostName: "",
        hostKey: settings.hostKey,
        directUrl: settings.directUrl,
      },
    ];
    this.#apply({ ...settings, hostName: "", members: roster }, opened);
  }

  /**
   * `opened` is a session to the selected member that pairing already proved: its store runs on it instead of dialing.
   * `keepShown`: an edit to how this app dials keeps a machine shown for one that is down, unless it chooses another (#2535).
   */
  #apply(settings: ConnectionSettings, opened?: OpenConnection, keepShown = false): void {
    if (!keepShown || settings.hostId !== this.#settings.hostId) this.#selection = undefined;
    this.#settings = normalizeSettings(settings);
    saveSettings(this.#settings);
    // A settings change is the app asking to dial with them, which is how the boot path replaces a stale saved port. Members that
    // already dialled are left alone; one that was stopped (by `restoring()`) is dialled again, which is the boot case where the
    // endpoint never changed and nothing else would start it (review of #994).
    this.#running = true;
    this.#sync(opened);
    if (this.#selection !== undefined && !this.#targets.has(this.#selection)) this.#selection = undefined;
    this.#startAll();
    this.#notify();
  }

  /** Shows another member's connection without touching any connection: the others stay open while this app looks elsewhere. */
  select(hostId: string): void {
    if (this.#targets.has(hostId)) this.#picked = hostId;
    if (hostId === this.settings.hostId || !this.#targets.has(hostId)) return;
    const target = this.#targets.get(hostId);
    if (target === undefined) return;
    if (!this.#settings.members.some((member) => member.hostId === hostId)) {
      this.#selection = hostId;
      this.#notify();
      return;
    }
    this.#selection = undefined;
    this.#settings = {
      ...this.#settings,
      hostId: target.hostId,
      hostName: target.hostName,
      hostKey: target.hostKey,
      directUrl: target.directUrl,
    };
    saveSettings(this.#settings);
    this.#notify();
  }

  /**
   * Begins dialling every member that is not open or connecting.
   *
   * This is also the "Try now" the first-connect screen offers, which means retry every member that failed: with the started set
   * left in place a member that had already dialled was skipped and the button did nothing (caught by first-connect-offline in
   * CI). A member that is open or mid-connect is left alone, because its store's `start()` stops it first: an open session would
   * close and a connecting one would go back to its first attempt (#1005).
   */
  start(): void {
    this.#running = true;
    for (const [hostId, store] of this.#stores) {
      const phase = store.state.phase;
      if (phase !== "open" && phase !== "connecting") this.#started.delete(hostId);
    }
    this.#startAll();
  }

  /** Starts every member that has not been started yet; a member already dialling keeps its connection. */
  #startAll(): void {
    for (const [hostId, store] of this.#stores) {
      if (this.#started.has(hostId)) continue;
      this.#started.add(hostId);
      store.start();
    }
  }

  /** The desktop app restarting this computer's own host: only the member on loopback is affected, and it will be dialled again. */
  restoring(): void {
    // The store stops itself; this records that it must be dialled again by the settings the boot path hands over next. Only that
    // member is forgotten: the next settings change starts every member not in the set, and `start()` on an open store closes it
    // (#1140).
    const store = this.selected;
    if (store === undefined) return;
    for (const [hostId, held] of this.#stores) if (held === store) this.#started.delete(hostId);
    store.restoring();
  }

  restartsLocalHost(starter: LocalHostStarter): void {
    this.#localHost = starter;
    for (const store of this.#stores.values()) store.restartsLocalHost(starter);
  }

  hostStartFailed(failure: HostStartFailure): void {
    this.selected?.hostStartFailed(failure);
  }

  stop(): void {
    this.#running = false;
    this.#started.clear();
    for (const store of this.#stores.values()) store.stop();
  }

  /** Retries one member: the row a person clicked, not every connection this app holds. */
  retry(hostId: string): void {
    this.#stores.get(hostId)?.retryNow();
  }

  retryNow(): void {
    for (const store of this.#stores.values()) store.retryNow();
  }

  /** The members this app dials: the roster, plus the selected host when the two disagree so it is never left unreachable. */
  #roster(): readonly MemberTarget[] {
    const paired = this.#pairedRoster();
    return [...paired, ...this.#view.filter((view) => !paired.some((member) => member.hostId === view.hostId))];
  }

  #pairedRoster(): readonly MemberTarget[] {
    const { members, hostId, hostName, hostKey, directUrl } = this.#settings;
    const selected: MemberTarget = { hostId, hostName, hostKey, directUrl };
    if (members.length > 0) {
      return hostId !== "" && !members.some((member) => member.hostId === hostId) ? [selected, ...members] : members;
    }
    // No roster yet: this computer's own host over loopback is the one machine there is. In relay mode with nothing paired
    // there is nothing to dial at all.
    return hostId === "" && this.#settings.mode !== "loopback" ? [] : [selected];
  }

  /** `opened` goes to the selected member's store, which then runs on it and dials nothing; unused, it is closed. */
  #sync(opened?: OpenConnection): void {
    const roster = this.#roster();
    const keep = new Set(roster.map((member) => member.hostId));
    for (const [hostId, unsubscribe] of this.#unsubscribes) {
      if (keep.has(hostId)) continue;
      unsubscribe();
      this.#unsubscribes.delete(hostId);
      this.#stores.get(hostId)?.stop();
      this.#stores.delete(hostId);
      this.#started.delete(hostId);
      this.#targets.delete(hostId);
    }
    // The store the proved session goes to, adopted once every store is listened to: its first open must reach #onMember.
    let adoption: (() => void) | undefined;
    for (const member of roster) {
      const existing = this.#stores.get(member.hostId);
      this.#targets.set(member.hostId, member);
      const proved = member.hostId === this.#settings.hostId ? opened : undefined;
      if (existing !== undefined) {
        // The shared settings can change under a member that is already dialled: a new relay, another mode, a fresh loopback
        // token. Only the members whose slice changed are told, so an untouched connection is not torn down for an edit that
        // does not concern it. A member taking a proved session gets its slice with it, so it does not dial first.
        const scoped = this.#scoped(member);
        if (proved !== undefined) adoption = () => existing.adopt(proved, scoped);
        else if (!sameTarget(existing.settings, scoped)) existing.update(scoped);
        continue;
      }
      const store = this.#dial(member, proved !== undefined);
      this.#stores.set(member.hostId, store);
      if (proved !== undefined) adoption = () => store.adopt(proved);
    }
    if (adoption === undefined) return opened?.connection.close();
    this.#started.add(this.#settings.hostId);
    adoption();
  }

  /** One member's settings: the shared ones, with that member's own address and a roster of just itself. */
  #scoped(member: MemberTarget): ConnectionSettings {
    const learned = !this.#pairedRoster().some((paired) => paired.hostId === member.hostId);
    return {
      ...this.#settings,
      ...(learned ? { mode: "relay", viewMember: true } : {}),
      hostId: member.hostId,
      hostName: member.hostName,
      hostKey: member.hostKey,
      directUrl: member.directUrl,
      members: [member],
    };
  }

  /** `adopting`: the store is about to take a proved session, so it is not started. */
  #dial(member: MemberTarget, adopting = false): MemberConnection {
    const scoped = this.#scoped(member);
    // A member's store holds a slice of a roster this object owns, so it must not write: saving its slice would replace the
    // roster with one member.
    const store = this.#make(scoped, () => undefined);
    if (this.#localHost !== null) store.restartsLocalHost(this.#localHost);
    if (!adopting && this.#running) {
      this.#started.add(member.hostId);
      store.start();
    }
    this.#unsubscribes.set(
      member.hostId,
      store.subscribe(() => this.#onMember(member.hostId, store)),
    );
    return store;
  }

  /**
   * A member names itself as it answers, and that name is the only way to label it while it is down (#496). The name arrives on
   * the member's own store, so it is folded back into the roster and saved here, the one place the roster is written.
   */
  /**
   * A member reported a change. The name it answers with is folded into the roster, and the shown machine moves off one this
   * app has not reached since it started.
   *
   * A store holds a one-member roster, so the rotation inside `ConnectionStore` cannot run for it: without this a start whose
   * saved machine is down would show nothing while the others were open (review of #994). A machine that was reached is the
   * one the person is looking at, so its drop never moves them to another: its workspace stays, saying it reconnects (#2464).
   */
  #onMember(hostId: string, store: MemberConnection): void {
    if (store.state.phase === "open") this.#lastSeen.set(hostId, Date.now());
    this.#adoptName(hostId, store);
    this.#failOver();
    // One notification for both: a reader must see the new selection, not the dead machine the name update was about.
    this.#notify();
  }

  #failOver(): void {
    const current = this.selected;
    if (current === undefined) return;
    const kept = (id: string): boolean => this.#lastSeen.has(id) || id === this.#picked;
    const hostId = failOverTo(this.#stores, current, kept, this.#holdsPlace());
    if (hostId === undefined || !this.#targets.has(hostId) || hostId === this.settings.hostId) return;
    // Shown, never saved: the machine the person chose stays the one a later start opens (#2532).
    this.#selection = hostId;
  }

  #adoptName(hostId: string, store: MemberConnection): void {
    const name = store.settings.hostName;
    const target = this.#targets.get(hostId);
    // Loopback is one gateway for every member, so the hello that answers says nothing about which member replied: adopting it
    // would rename every machine after the one local host.
    if (store.settings.mode === "loopback") return;
    if (store.settings.viewMember === true) return;
    if (target === undefined || name === "" || name === target.hostName) return;
    const renamed: MemberTarget = { ...target, hostName: name };
    this.#targets.set(hostId, renamed);
    const members = this.#settings.members.map((member) => (member.hostId === hostId ? renamed : member));
    const selected = this.#settings.hostId === hostId ? { hostName: name } : {};
    this.#settings = normalizeSettings({ ...this.#settings, ...selected, members });
    saveSettings(this.#settings);
  }

  #refresh(): void {
    const selected = this.#targets.get(this.#selection ?? this.#settings.hostId) ?? this.#targets.values().next().value;
    const learned = selected !== undefined && !this.#pairedRoster().some((paired) => paired.hostId === selected.hostId);
    this.#visibleSettings =
      selected === undefined || selected.hostId === this.#settings.hostId
        ? this.#settings
        : {
            ...this.#settings,
            ...selected,
            ...(learned ? { mode: "relay", viewMember: true } : {}),
          };
    this.#snapshot = [...this.#targets.values()].map((target) =>
      Object.assign(
        {
          target,
          state: this.#stores.get(target.hostId)?.state ?? UNSET,
        },
        this.#lastSeen.has(target.hostId) ? { lastSeen: this.#lastSeen.get(target.hostId) } : {},
      ),
    );
  }

  #notify(): void {
    this.#refresh();
    for (const listener of this.#listeners) listener();
  }
}
