import type { AttachOptions, HcConnection, TerminalStream } from "@doriface/client";
import { type Display, HcRpcError, type TerminalAttachParams, type TerminalRunParams } from "@doriface/protocol";

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
 * the terminal's run when there is one, told the view's own colours if they differ; else, or when that one found no
 * terminal (a host that sent it on before the run had answered), the view's own `attach`. Any other failure is the
 * attach's own, and is the view's to show.
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
  } catch (error) {
    // An older host hands the attach to hc before the run has answered, and hc finds no terminal by that name yet.
    if (error instanceof HcRpcError && error.kind === "not_found") return own();
    throw error;
  }
  if (JSON.stringify(early.display) !== JSON.stringify(asked.display)) stream.facts(asked.display);
  return { stream, cols: early.cols, rows: early.rows };
}
