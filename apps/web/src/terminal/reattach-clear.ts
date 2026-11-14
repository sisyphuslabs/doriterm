import type { HcConnection } from "@doriface/client";
import { compareHcVersions, type MachineView } from "@doriface/protocol";
import { machineOf } from "../workspace/model.ts";
import { useMachinesContext } from "../workspace/use-machines.ts";

/** The first herdr-core whose reattach repaint draws the primary screen again behind a full-screen program (#2514). */
export const REPAINTS_PRIMARY_FROM = "0.1.21";

/**
 * What a reattached view writes before the core's repaint, so the repaint lands on a blank screen and the history stays
 * as the view holds it (#1997). Cursor home, then erase to the end (ED 0), clears the screen in use: the repaint's ESC[2J
 * then has nothing to scroll into history over a prompt marked with OSC 133 (#1999).
 *
 * Under a full-screen program (vim, less, htop) that clears the alternate screen only. A core before 0.1.21 does not
 * draw the primary screen again, and its ESC[2J scrolls the primary screen behind the program into history once: that is
 * the only copy of the output above the program's command, so the primary screen is left as it is. A core from 0.1.21
 * draws the primary screen again before it enters the alternate one, so the view leaves the alternate screen and clears
 * the primary one too; otherwise each reconnect scrolls one more copy into history and the program's exit shows the
 * redrawn one besides (#2514). Only a plain release (major.minor.patch) counts: an unknown, pre-release or malformed version
 * is read as an older core, which keeps the output rather than erasing its only copy.
 */
export function reattachClear(coreVersion: string | undefined): string {
  const version = coreVersion?.replace(/^hc /, "");
  const repaintsPrimary =
    version !== undefined && /^\d+\.\d+\.\d+$/.test(version) && compareHcVersions(version, REPAINTS_PRIMARY_FROM) >= 0;
  return repaintsPrimary ? "\u001b[?1049l\u001b[H\u001b[J" : "\u001b[H\u001b[J";
}

/**
 * The version of the core that repaints the terminal at `address`: this core's own for its terminals, the added
 * machine's as machine.list last reported it for one of that machine's; undefined while that machine is not listed.
 */
export function repaintingCore(
  address: string,
  ownVersion: string,
  views: readonly Pick<MachineView, "name" | "version">[],
): string | undefined {
  const machine = machineOf(address);
  if (machine === undefined) return ownVersion;
  return views.find((view) => view.name === machine)?.version;
}

/** repaintingCore for a view on this connection, with the machines as the workspace lists them. */
export function useRepaintingCore(connection: HcConnection, address: string): string | undefined {
  const { views } = useMachinesContext();
  return repaintingCore(address, connection.hello.version, views);
}
