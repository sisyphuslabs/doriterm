import { takeOpeningAttach } from "./opening-attach.ts";

/**
 * Attaches whose view went away before the core answered them, by connection and terminal (#2475). Until its answer
 * names the stream, the page cannot close it, so the core still holds that view as a viewer, at that view's size. An
 * attach for the same terminal that reaches the core meanwhile has its first paint drawn at that size, and the core
 * does not paint it again when the old viewer leaves: a phone turned to landscape and back before the landscape view's
 * answer came kept the landscape view's rows, the rows below them blank. A view's attach therefore waits until the
 * attach its terminal's previous view left behind is answered and closed.
 */
const leaving = new WeakMap<object, Map<string, Promise<unknown>>>();

/** Notes that the attach `settled` (answered, then closed) belongs to a view that has gone. */
export function noteLeaving(connection: object, address: string, settled: Promise<unknown>): void {
  const byAddress = leaving.get(connection) ?? new Map<string, Promise<unknown>>();
  leaving.set(connection, byAddress);
  const done = Promise.allSettled([byAddress.get(address), settled]);
  byAddress.set(address, done);
  void done.finally(() => {
    if (byAddress.get(address) === done) byAddress.delete(address);
  });
}

/** Settles once every attach to `address` that a gone view left on `connection` is answered and closed. */
export function afterLeaving(connection: object, address: string): Promise<unknown> {
  return leaving.get(connection)?.get(address) ?? Promise.resolve();
}

/**
 * Closes the attach sent ahead with `address`'s run, for a view that went before using it: left open, it would hold the
 * core's viewer at that view's size, the bug above (#2496 review). Settles once the core has closed it, so the next
 * view's wait holds until then.
 */
export function dropOpeningAttach(connection: object, address: string): Promise<unknown> {
  const early = takeOpeningAttach(connection, address);
  if (early === undefined) return Promise.resolve();
  return early.stream.then(
    (left) => left.close(),
    () => undefined,
  );
}
