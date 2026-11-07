import type { AttachOptions, HcConnection, TerminalStream } from "@doriface/client";
import type { Display, TerminalAttachParams, TerminalRunParams } from "@doriface/protocol";

export interface OpeningAttach {
  readonly cols: number;
  readonly rows: number;
  readonly display: Display | undefined;
  readonly stream: Promise<TerminalStream>;
}

/** Names this page gives the terminals it starts, so the attach can name the terminal before the run has answered. */
export const OPENING_NAME_PREFIX = "opened-";

export const HISTORY_LINES = 2_000;

const DEFAULT_SIZE = { cols: 80, rows: 24 } as const;
let lastSize: { readonly cols: number; readonly rows: number } = DEFAULT_SIZE;
const opening = new WeakMap<object, Map<string, OpeningAttach>>();
/** Opening attaches not yet answered, by connection and by the machine their address names (null: the core itself). */
const unanswered = new WeakMap<object, Map<string | null, Set<Promise<unknown>>>>();

const machineOfAddress = (address: string): string | null => {
  const slash = address.indexOf("/");
  return slash === -1 ? null : address.slice(0, slash);
};

function track(connection: object, address: string, stream: Promise<unknown>): void {
  const byMachine = unanswered.get(connection) ?? new Map<string | null, Set<Promise<unknown>>>();
  unanswered.set(connection, byMachine);
  const machine = machineOfAddress(address);
  const pending = byMachine.get(machine) ?? new Set<Promise<unknown>>();
  byMachine.set(machine, pending);
  pending.add(stream);
  const forget = (): void => {
    pending.delete(stream);
  };
  stream.then(forget, forget);
}

/**
 * Settles once every opening attach to `machine` (null: the core itself) sent so far has been answered. A layout write
 * waits for it (#1351): hc makes a document durable on disk while it holds its state, so an attach that reached the
 * core behind that write waited for the disk, by tens to hundreds of ms on a busy one.
 */
export function openingAttachesAnswered(connection: object, machine: string | null): Promise<unknown> {
  const pending = unanswered.get(connection)?.get(machine);
  return pending === undefined || pending.size === 0 ? Promise.resolve() : Promise.allSettled(pending);
}

/** The two calls a run with its attach makes, on one connection. */
export interface OpeningCalls {
  readonly run: (params: TerminalRunParams) => Promise<{ readonly address: string }>;
  readonly attach: (params: TerminalAttachParams, options: AttachOptions) => Promise<TerminalStream>;
}

export const openingCallsOf = (connection: HcConnection): OpeningCalls => ({
  run: (params) => connection.call("terminal.run", params),
  attach: (params, options) => connection.attach(params, options),
});

/** The grid a view last fitted to: a new terminal opens where the last one was shown, so it most likely gets the same. */
export function noteViewSize(cols: number, rows: number): void {
  if (cols > 0 && rows > 0) lastSize = { cols, rows };
}

export function isOpeningName(name: string | null | undefined): boolean {
  return name?.startsWith(OPENING_NAME_PREFIX) === true;
}

function openingName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return OPENING_NAME_PREFIX + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Starts a terminal and asks for its screen in the same breath (#1351): the run names the terminal, and the attach
 * that names it goes right behind the run, so the host hands it to the core once the run has answered and the first
 * screen is one round trip away instead of two. The view that opens the address takes that attach
 * ({@link takeOpeningAttach}). A run that fails takes its attach down with it.
 */
export async function runWithAttach(
  connection: object,
  calls: OpeningCalls,
  params: TerminalRunParams,
  display: Display | undefined,
): Promise<{ readonly address: string }> {
  const name = params.name ?? openingName();
  const { cols, rows } = lastSize;
  const ran = calls.run({ ...params, name, size: { cols, rows } });
  const terminal = params.on === undefined || params.on === null ? name : `${params.on}/${name}`;
  const stream = calls.attach(
    { terminal, cols, rows, history: HISTORY_LINES, ...(display === undefined ? {} : { display }) },
    { autoCredit: false },
  );
  // Settled by whoever takes it, or closed here when nobody will: never an unhandled rejection.
  stream.catch(() => undefined);
  track(connection, terminal, stream);
  try {
    const { address } = await ran;
    const byAddress = opening.get(connection) ?? new Map<string, OpeningAttach>();
    opening.set(connection, byAddress);
    byAddress.set(address, { cols, rows, display, stream });
    return { address };
  } catch (error) {
    void stream.then(
      (attached) => attached.close(),
      () => undefined,
    );
    throw error;
  }
}

/**
 * Asks for a terminal's screen before the tab that will show it is written to the layout, which waits for the answer
 * ({@link openingAttachesAnswered}). The view that opens the address takes this attach.
 */
export function attachAhead(
  connection: object,
  calls: Pick<OpeningCalls, "attach">,
  address: string,
  display: Display,
): void {
  const byAddress = opening.get(connection) ?? new Map<string, OpeningAttach>();
  opening.set(connection, byAddress);
  if (byAddress.has(address)) return;
  const { cols, rows } = lastSize;
  const stream = calls.attach(
    { terminal: address, cols, rows, history: HISTORY_LINES, display },
    { autoCredit: false },
  );
  stream.catch(() => undefined);
  track(connection, address, stream);
  byAddress.set(address, { cols, rows, display, stream });
}

/** The attach sent with this terminal's run, once: the first view to open it on that connection takes it. */
export function takeOpeningAttach(connection: object, address: string): OpeningAttach | undefined {
  const byAddress = opening.get(connection);
  const found = byAddress?.get(address);
  byAddress?.delete(address);
  return found;
}

interface Asked {
  readonly cols: number;
  readonly rows: number;
  readonly display: Display;
}

/**
 * The stream a view opens its terminal with, and the grid the core was asked for: on a first attach, the one sent with
 * the terminal's run when there is one, told the view's own colours if they differ; else, or when that one failed (a
 * host that sent it on before the run had answered), the view's own `attach`.
 */
export async function viewAttach(
  connection: object,
  address: string,
  first: boolean,
  asked: Asked,
  attach: () => Promise<TerminalStream>,
): Promise<{ readonly stream: TerminalStream; readonly cols: number; readonly rows: number }> {
  const early = first ? takeOpeningAttach(connection, address) : undefined;
  const own = async () => ({ stream: await attach(), cols: asked.cols, rows: asked.rows });
  if (early === undefined) return own();
  let stream: TerminalStream;
  try {
    stream = await early.stream;
  } catch {
    return own();
  }
  if (JSON.stringify(early.display) !== JSON.stringify(asked.display)) stream.facts(asked.display);
  return { stream, cols: early.cols, rows: early.rows };
}
