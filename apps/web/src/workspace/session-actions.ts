import type { HcConnection } from "@doriface/client";
import {
  END_LABEL,
  HcRpcError,
  type Terminal,
  type TerminalKillParams,
  type TerminalLabelParams,
  type TerminalRmParams,
} from "@doriface/protocol";

/**
 * The label a renamed session carries; terminalTitle reads it before hc's name and the program's title. herdr-app's
 * label rules (docs/labels.md, "Adding more") put state clients share in a herdr.-prefixed label, so every herdr
 * client can read it and a bare key cannot collide with a user's or an agent's own labels (D22).
 */
export const TITLE_LABEL = "herdr.name";

/** The hc calls a session action makes. */
export interface SessionCalls {
  readonly label: (params: TerminalLabelParams) => Promise<unknown>;
  readonly kill: (params: TerminalKillParams) => Promise<Pick<Terminal, "state">>;
  readonly rm: (params: TerminalRmParams) => Promise<unknown>;
}

export function sessionCalls(connection: HcConnection): SessionCalls {
  return {
    label: (params) => connection.call("terminal.label", params),
    kill: (params) => connection.call("terminal.kill", params),
    rm: (params) => connection.call("terminal.rm", params),
  };
}

/** Names a session for every client: a label on the terminal, or no label when the name is cleared. */
export async function renameSession(calls: SessionCalls, address: string, name: string): Promise<void> {
  await calls.label({ terminal: address, labels: { [TITLE_LABEL]: name.trim() } });
}

/**
 * Ends in flight, by address. An End belongs to the session, not to the screen that asked for it: the program's exit
 * closes that screen before End's terminal.rm goes out, and a page closed then would leave the terminal finished.
 */
const ending = new Map<string, Promise<void>>();

/** Removed meanwhile (another client, the host, or an earlier attempt's removal arriving late): what End is for. */
export const isGone = (cause: unknown): boolean => cause instanceof HcRpcError && cause.kind === "not_found";

/**
 * Takes End's mark off a terminal whose End did not kill it, so a later finish of its program is not taken for End's.
 * An empty value removes the label.
 */
export async function takeBackEnd(calls: SessionCalls, address: string): Promise<void> {
  try {
    await calls.label({ terminal: address, labels: { [END_LABEL]: "" } });
  } catch (cause) {
    if (!isGone(cause)) throw cause;
  }
}

/** Addresses whose latest End killed the program, whatever happened after (terminal.rm, the END label). */
const killed = new Set<string>();

/**
 * True when the latest End of the session at `address` killed its program, even if that End then rejected because
 * terminal.rm or the END label call failed: the session has ended, though End reported an error (#1342).
 */
export function killWentThrough(address: string): boolean {
  return killed.has(address);
}

async function killAndRemove(calls: SessionCalls, address: string): Promise<void> {
  // The mark leaves with the kill, so a page closed before terminal.rm goes out still has the host remove it (END_LABEL).
  const marked = calls.label({ terminal: address, labels: { [END_LABEL]: "1" } });
  let notKilled = false;
  killed.delete(address);
  const removed = (async () => {
    let ended: Pick<Terminal, "state">;
    try {
      ended = await calls.kill({ terminal: address });
    } catch (cause) {
      notKilled = !isGone(cause);
      throw cause;
    }
    killed.add(address);
    if (ended.state === "finished") await calls.rm({ terminal: address });
  })();
  const failed = (await Promise.allSettled([marked, removed])).find(
    (outcome) => outcome.status === "rejected" && !isGone(outcome.reason),
  );
  if (failed?.status !== "rejected") {
    killed.delete(address);
    return;
  }
  if (notKilled) {
    await takeBackEnd(calls, address).catch((cause: unknown) =>
      console.error(`take End's mark off ${address}: ${String(cause)}`),
    );
  }
  throw failed.reason;
}

/** Ends the program (hangup, then terminate, then kill) and removes the finished terminal from hc. */
export function endSession(calls: SessionCalls, address: string): Promise<void> {
  const run = killAndRemove(calls, address);
  ending.set(address, run);
  const settle = (): void => {
    if (ending.get(address) === run) ending.delete(address);
  };
  run.then(settle, settle);
  return run;
}

/** Runs `then` once no End of this session is in flight: at once, or when that End has removed the terminal or failed. */
export function afterEnd(address: string, then: () => void): void {
  const run = ending.get(address);
  if (run === undefined) then();
  else run.then(then, then);
}
