import { eventAddress, type HcEvent, type HcSnapshot, type Terminal } from "@doriface/protocol";

export type TerminalMap = ReadonlyMap<string, Terminal>;

export function fromSnapshot(snapshot: HcSnapshot): TerminalMap {
  return new Map(snapshot.terminals.map((terminal) => [terminal.address, terminal]));
}

/** Applies one event; unchanged maps are returned as-is so React can skip a render. */
export function applyEvent(terminals: TerminalMap, event: HcEvent): TerminalMap {
  const address = eventAddress(event);
  if (address === undefined) return terminals;
  const current = terminals.get(address);
  const next = new Map(terminals);
  const patch = (fields: Partial<Terminal>): TerminalMap => {
    if (current === undefined) return terminals;
    next.set(address, { ...current, ...fields });
    return next;
  };
  switch (event.type) {
    case "created":
    case "restarted":
      next.set(address, { ...event.data, address });
      return next;
    case "removed":
      next.delete(address);
      return next;
    case "finished":
    case "lost":
      return patch({
        state: event.type === "finished" ? "finished" : "live",
        reason: event.data.reason,
        exit_code: event.data.exit_code,
        signal: event.data.signal,
        finished_ms: event.data.finished_ms,
        status: null,
      });
    case "status":
      return patch({ status: event.data.status, records: event.data.records, reported: event.data.reported });
    case "turn":
      return patch({ turn: event.data.turn });
    case "title":
      return patch({ title: event.data.title });
    case "labels":
      return patch({ labels: event.data.labels });
    case "size":
      return patch({ cols: event.data.cols, rows: event.data.rows });
    case "foreground":
      return patch({ foreground: event.data });
    case "keep":
      return patch({ keep: event.data.keep });
    case "doc":
      return terminals;
  }
}
