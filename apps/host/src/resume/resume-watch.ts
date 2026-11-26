/**
 * OSC 7577 on the host. For each terminal a client started here with a token, the host watches its output (an observe
 * attach: it never types or resizes) for reports, keeps what they say, and once the core has lost that terminal (a core
 * restart or a reboot) brings the record's program back. Watches over one `hc connect` of its own, opened again when
 * the core restarts, as the end sweeper does.
 */
import { join } from "node:path";
import type { HcConnection, TerminalStream } from "@doriface/client";
import { eventAddress, type HcEvent, type Terminal } from "@doriface/protocol";
import { type HcTarget, type KillableLink, openOnCore, spawnHcLink } from "../mesh/hc-machines.ts";
import { takeReport } from "./intake.ts";
import { Osc7577Scanner } from "./osc7577.ts";
import { type FactsOf, processFacts } from "./process-facts.ts";
import { ResumeStore } from "./records.ts";
import { relaunch } from "./relaunch.ts";
import type { RunStarted } from "./run-tokens.ts";

/** The finishes that end a terminal for good; any other (the core stopping, a lost program) keeps its record. */
const FINAL: ReadonlySet<string> = new Set(["exited", "killed"]);
/** How long an owner may be gone before its record goes: one that exited as the terminal ended still resumes. */
export const OWNER_EXIT_GRACE_MS = 2_000;

export interface ResumeWatchOptions {
  readonly core: HcTarget;
  readonly stateDir: string;
  /** This host's own program, which runs `resume-exec`. */
  readonly program: string;
  readonly log: (line: string) => void;
  readonly link?: (core: HcTarget) => KillableLink;
  readonly factsOf?: FactsOf;
  /** The user's shell, for a record that was its terminal's first process; `$SHELL` unless given. */
  readonly shell?: string | undefined;
  /** How often owners are looked for. */
  readonly sweepMs?: number;
  /** For tests: how long an owner may be gone before its record goes (default OWNER_EXIT_GRACE_MS). */
  readonly ownerExitGraceMs?: number;
  /** For tests: a terminal's output is being watched from now on. */
  readonly onWatching?: (address: string) => void;
}

export interface ResumeWatch {
  /** Watches the core unless a watch is open already; a closed one (the core restarted) is opened again. */
  ensure(): Promise<void>;
  /** A client's run started a terminal with a token. */
  started(run: RunStarted): void;
  stop(): Promise<void>;
  kill(): readonly number[];
}

export function resumeWatch(options: ResumeWatchOptions): ResumeWatch {
  const { core, log } = options;
  const factsOf = options.factsOf ?? processFacts;
  const uid = process.getuid?.() ?? -1;
  const store = ResumeStore.open(join(options.stateDir, "resume"));
  const streams = new Map<string, TerminalStream>();
  /** Each live terminal's first process, so a report's pid can be placed inside it. */
  const roots = new Map<string, number | undefined>();
  /** Reports are taken one after another per terminal: a later one never overtakes an earlier one. */
  const queues = new Map<string, Promise<unknown>>();
  /** When each record's owner was first seen gone. */
  const gone = new Map<string, number>();
  let open: HcConnection | undefined;
  let watching: Promise<HcConnection | undefined> | undefined;
  let child: KillableLink | undefined;
  let childOpen = false;
  /** Settles once the latest `hc connect` child has exited, so `stop` leaves no child behind. */
  let exited: Promise<void> = Promise.resolve();
  let stopped = false;

  const forget = (address: string): void => {
    streams.get(address)?.close();
    streams.delete(address);
    roots.delete(address);
    gone.delete(address);
    store.forget(address);
  };

  const observe = async (connection: HcConnection, terminal: Terminal): Promise<void> => {
    const { address } = terminal;
    if (streams.has(address) || store.entry(address) === undefined) return;
    roots.set(address, terminal.pid ?? undefined);
    const stream = await connection.attach({
      terminal: address,
      cols: terminal.cols,
      rows: terminal.rows,
      observe: true,
    });
    streams.set(address, stream);
    const scanner = new Osc7577Scanner();
    stream.onData((bytes) => {
      for (const body of scanner.feed(bytes)) {
        const deps = { store, factsOf, nowS: () => Math.floor(Date.now() / 1000), uid, log };
        const next = (queues.get(address) ?? Promise.resolve()).then(() =>
          takeReport(deps, address, roots.get(address), body),
        );
        queues.set(
          address,
          next.catch((error: unknown) => log(`resume: ${address}: ${String(error)}`)),
        );
      }
    });
    stream.onClose(() => {
      if (streams.get(address) === stream) streams.delete(address);
    });
    options.onWatching?.(address);
  };

  const relaunchDeps = (connection: HcConnection) => ({
    connection,
    store,
    launchDir: join(options.stateDir, "resume", "launch"),
    program: options.program,
    shell: options.shell ?? process.env["SHELL"],
    uid,
    log,
    watch: (run: RunStarted) => watchRun(connection, run),
  });

  /** Sorts every stored terminal against the core: watch the live ones, relaunch the lost ones, drop the ended ones. */
  const restore = async (connection: HcConnection): Promise<void> => {
    const listed = new Map(
      (await connection.call("terminal.list", { all: true })).terminals.map((each) => [each.address, each]),
    );
    await Promise.all(
      store.addresses().map(async (address) => {
        const terminal = listed.get(address);
        if (terminal?.state === "live") return observe(connection, terminal);
        if (terminal !== undefined && FINAL.has(terminal.reason ?? "")) return forget(address);
        if (store.entry(address)?.record === undefined) return forget(address);
        return relaunch(relaunchDeps(connection), address, terminal);
      }),
    );
  };

  const apply = (event: HcEvent): void => {
    const address = eventAddress(event);
    if (address === undefined || store.entry(address) === undefined) return;
    if (event.type === "removed" || (event.type === "finished" && FINAL.has(event.data.reason ?? ""))) forget(address);
    else if (event.type === "finished") roots.delete(address);
  };

  const watch = async (): Promise<HcConnection> => {
    const next = (options.link ?? spawnHcLink)(core);
    const closed = Promise.withResolvers<void>();
    next.onClose(() => {
      if (child === next) childOpen = false;
      closed.resolve();
    });
    child = next;
    childOpen = true;
    exited = closed.promise;
    const connection = await openOnCore(next, core);
    try {
      const feed = await connection.subscribe();
      feed.onEvent(apply);
      await restore(connection);
    } catch (error) {
      connection.close();
      throw error;
    }
    return connection;
  };

  const ensure = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (watching === undefined || open?.closed === true) {
      open = undefined;
      streams.clear();
      const attempt: Promise<HcConnection | undefined> = watch().then(
        (connection) => (open = connection),
        (error: unknown) => {
          if (!stopped) log(`resume: not watching the core: ${String(error)}`);
          if (watching === attempt) watching = undefined;
          return undefined;
        },
      );
      watching = attempt;
    }
    return watching.then(() => undefined);
  };

  /** Tracks a terminal started with a token and settles once its output is watched. */
  const watchRun = async (connection: HcConnection, run: RunStarted): Promise<void> => {
    store.track(run.address, run);
    await observe(connection, await connection.call("terminal.get", { terminal: run.address }));
  };

  const started = (run: RunStarted): void => {
    const connection = open;
    if (connection === undefined || connection.closed) {
      store.track(run.address, run);
      return void ensure();
    }
    watchRun(connection, run).catch((error: unknown) => log(`resume: watching ${run.address}: ${String(error)}`));
  };

  /** A record whose owner is gone while its terminal lives on is over; one the terminal's end took keeps. */
  const sweep = async (): Promise<void> => {
    const owners = [...roots.keys()].flatMap((address) => {
      const record = store.entry(address)?.record;
      return record === undefined ? [] : [{ address, record }];
    });
    const facts = await Promise.all(owners.map(({ record }) => factsOf(record.pid)));
    owners.forEach(({ address, record }, index) => {
      const owner = facts[index];
      if (owner !== undefined && owner.started === record.started) gone.delete(address);
      else if (!gone.has(address)) gone.set(address, Date.now());
      else if (Date.now() - (gone.get(address) ?? 0) >= (options.ownerExitGraceMs ?? OWNER_EXIT_GRACE_MS)) {
        gone.delete(address);
        store.clear(address, record.pid);
      }
    });
  };
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping || stopped) return;
    sweeping = true;
    sweep()
      .catch((error: unknown) => log(`resume: looking for owners: ${String(error)}`))
      .finally(() => (sweeping = false));
  }, options.sweepMs ?? 500);
  timer.unref();

  return {
    ensure,
    started,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      for (const stream of streams.values()) stream.close();
      (await watching)?.close();
      await exited;
    },
    kill: () => {
      if (child?.kill === undefined || child.pid === undefined || !childOpen) return [];
      child.kill("SIGKILL");
      return [child.pid];
    },
  };
}
