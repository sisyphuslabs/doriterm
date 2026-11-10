import { HcRpcError, type Terminal } from "@doriface/protocol";

/** The core's answer about a terminal (terminal.get), or why it gave none. */
export type CoreAnswer = { readonly terminal: Pick<Terminal, "state" | "pid"> } | { readonly error: unknown };

/**
 * What a view does once the core ended its stream without the program finishing, or refused an attach:
 * - `finished`: a refused reattach found the program over, or the core no longer knows the terminal; the tab closes.
 * - `ended`: the program was already over when this view asked (a refused first attach, or a lost line whose end came
 *   while it was down); the view says it ended and offers to close the tab.
 * - `restarting`: lost, waiting for its new shell; the restarted program's pid gives the terminal a new view.
 * - `replaced`: another program runs there now; its own view attaches to it.
 * - `reattach`: the same program still runs; attach to it again.
 * - `error`: show why it could not be opened.
 */
export type Settled = "finished" | "ended" | "restarting" | "replaced" | "reattach" | "error";

export function settled(answer: CoreAnswer, program: number | null, first: boolean, refused: boolean): Settled {
  if ("error" in answer) return unknownToCore(answer.error) ? "finished" : "error";
  const { state, pid } = answer.terminal;
  // A terminal that ended while this view's line was down sent it no CLOSE: when the view asks after its lost stream,
  // it shows the end it missed instead of closing its tab. A refused reattach is the CLOSE the page missed, so that one
  // closes the tab (#164). A view that never attached (a reload, or a machine that was offline) shows ended too: the
  // core's state says so, whether or not this page had the terminal open.
  if (state !== "live") return refused && !first ? "finished" : "ended";
  if (pid === null || pid === undefined) return "restarting";
  if (pid !== program) return "replaced";
  return refused ? "error" : "reattach";
}

/** Why input still queued in a view that goes away was never sent, as the notice words it; null names no reason. */
export type Unsent = "restarted" | "ended" | null;

export function unsentReason(answer: CoreAnswer, program: number | null): Unsent {
  if ("error" in answer) return unknownToCore(answer.error) ? "ended" : null;
  if (answer.terminal.state !== "live") return "ended";
  return (answer.terminal.pid ?? null) === program ? null : "restarted";
}

const unknownToCore = (error: unknown): boolean => error instanceof HcRpcError && error.kind === "not_found";
