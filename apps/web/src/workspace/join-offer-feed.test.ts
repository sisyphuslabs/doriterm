import { expect, test } from "bun:test";
import { EventFeed } from "@doriface/client";
import { FrameKind, MESH_OFFER_DOC } from "@doriface/protocol";
import { followJoinOffer, offerFor, type JoinOffer } from "./join-command.ts";

test("the dialog reads a joined offer when missed replaces its document event", () => {
  const feed = new EventFeed(
    { sendBytes: () => {}, send: () => {}, sendClose: () => {}, unregister: () => {} },
    1,
    { seq: 1, terminals: [] },
    0,
  );
  let value: unknown = { request: "r", link: "doriface://pair#offer", expiresAt: 100 };
  const shown: JoinOffer[] = [];
  followJoinOffer(feed, () => {
    const next = offerFor(value, "r");
    if (next !== undefined) shown.push(next);
  });
  const deliver = (method: string, params: unknown): void =>
    feed.frame({
      channel: 1,
      kind: FrameKind.Data,
      payload: new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`),
    });

  deliver("event", { seq: 2, type: "doc", data: { name: MESH_OFFER_DOC, version: 1 } });
  expect(shown.at(-1)?.phase).toBe("ready");

  // A busy core drops the join's doc event and sends its replacement snapshot instead.
  value = { request: "r", joined: { name: "joiner", hostId: "h2" } };
  deliver("missed", { seq: 4, terminals: [] });
  expect(shown.at(-1)).toEqual({ phase: "joined", name: "joiner" });
  feed.close();
});

test("the dialog observes a missed snapshot queued before its first listener", () => {
  const feed = new EventFeed(
    { sendBytes: () => {}, send: () => {}, sendClose: () => {}, unregister: () => {} },
    1,
    { seq: 1, terminals: [] },
    0,
  );
  feed.frame({
    channel: 1,
    kind: FrameKind.Data,
    payload: new TextEncoder().encode('{"jsonrpc":"2.0","method":"missed","params":{"seq":4,"terminals":[]}}\n'),
  });
  let reads = 0;
  followJoinOffer(feed, () => {
    reads += 1;
  });
  expect(reads).toBe(1);
  feed.close();
});
