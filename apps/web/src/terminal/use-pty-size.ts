import type { HcConnection } from "@doriface/client";
import type { WTerm } from "@wterm/react";
import { useEffect } from "react";
import { rosterFor } from "../roster/roster.ts";
import type { HostSize } from "./host-size.ts";
import type { OutputPacer } from "./output-pacer.ts";

/**
 * A watching view follows the pty's size as the core's `size` events report it (D1, host-size.ts). The core sends a
 * viewer that may resize no RESIZE frames of its own (its attach answers `resize_notifications: false`), so a desk
 * resizing the pty reaches a watching phone through the terminal's record in the roster. Each change applies to the
 * grid after the output queued ahead of it, before what follows.
 */
export function usePtySize(
  connection: HcConnection,
  address: string,
  wt: WTerm | null,
  hostSize: HostSize,
  pacer: OutputPacer,
): void {
  useEffect(() => {
    if (wt === null) return undefined;
    const live = rosterFor(connection).live;
    let cols = 0;
    let rows = 0;
    const follow = (): void => {
      const terminal = live.get(address);
      if (terminal === undefined || (terminal.cols === cols && terminal.rows === rows)) return;
      ({ cols, rows } = terminal);
      const size = { cols, rows };
      pacer.inOrder(() => hostSize.ptySized(wt, size));
    };
    follow();
    return live.subscribeTo(address, follow);
  }, [connection, address, wt, hostSize, pacer]);
}
