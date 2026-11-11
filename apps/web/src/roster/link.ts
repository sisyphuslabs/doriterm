import type { EventFeed, HcConnection } from "@doriface/client";

export type FeedLink = Pick<EventFeed, "snapshot" | "onSnapshot" | "onEvent" | "onClose" | "close">;

/** What the roster needs from a connection; `HcConnection` is one, and a test's fake core is another. */
export interface RosterLink {
  readonly hello: HcConnection["hello"];
  readonly closed: boolean;
  readonly call: HcConnection["call"];
  readonly subscribe: () => Promise<FeedLink>;
}
