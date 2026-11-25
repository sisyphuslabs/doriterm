import type { TerminalRunParams, Terminal } from "@doriface/protocol";
import { machineOf } from "./model.ts";
import { HERDR_SPACE_LABEL } from "./placement.ts";

/** The space a new terminal is started for: its folder, its machine, and its id in that machine's layout document. */
export interface StartSpace {
  readonly dir: string;
  readonly machine?: string;
  /** The space's id in its machine's document; none when it is in no document (a transient tab's). */
  readonly space?: string;
}

/**
 * New terminal starts where the active one is: on its machine, in its directory (the shell's current one when hc
 * reports it), with its space label, so it joins the active space. With no terminal in focus it starts where the selected
 * space is, on that space's machine, as herdr-app's `folder_for` falls back to the space's folder; with neither, the
 * core's default.
 *
 * The space it is started for is named by its `herdr.space` label, as herdr-app labels the terminals it starts: a run
 * may answer long after its terminal is live (a template's answers once its agent is ready, up to a minute), and
 * whichever write places the terminal first, this page's or an adoption on any device (placeOf), puts it there instead
 * of a space of its own.
 */
export function runParamsFor(active: Terminal | undefined, selected?: StartSpace): TerminalRunParams {
  const placed = selected?.space === undefined ? {} : { [HERDR_SPACE_LABEL]: selected.space };
  if (active === undefined) {
    if (selected === undefined) return {};
    return {
      ...(selected.dir === "" ? {} : { cwd: selected.dir }),
      ...(selected.machine === undefined ? {} : { on: selected.machine }),
      ...(selected.space === undefined ? {} : { labels: placed }),
    };
  }
  const machine = machineOf(active.address);
  const space = active.labels["space"];
  const labels = { ...(space === undefined ? {} : { space }), ...placed };
  return {
    cwd: active.foreground?.cwd ?? active.cwd,
    ...(machine === undefined ? {} : { on: machine }),
    ...(Object.keys(labels).length === 0 ? {} : { labels }),
  };
}
