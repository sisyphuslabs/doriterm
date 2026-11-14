import { type DocState, LayoutDoc, ORDER_DOC, readOrderDocument } from "@doriface/protocol/layout";
import type { Schedule } from "./feed.ts";
import type { RosterLink } from "./link.ts";
import { Reread } from "./reread.ts";

/**
 * This core's machine-order document (the sidebar's machine order): one per core, kept like a layout document, and read
 * again by itself after a read that failed, as LayoutDocs reads a layout again (#2443).
 */
export function orderDoc(
  call: RosterLink["call"],
  changed: (state: DocState) => void,
  reading: () => boolean,
  schedule: Schedule,
): LayoutDoc {
  const doc: LayoutDoc = new LayoutDoc(
    {
      get: () => call("doc.get", { name: ORDER_DOC }),
      set: (_on, value, version) => call("doc.set", { name: ORDER_DOC, value, version }),
    },
    null,
    (state) => {
      if (state.phase === "unavailable") reread.failed();
      else reread.landed();
      changed(state);
    },
    readOrderDocument,
  );
  const reread = new Reread(() => void doc.refresh(), reading, schedule);
  return doc;
}
