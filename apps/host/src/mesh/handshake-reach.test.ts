import { expect, test } from "bun:test";
import type { ChildByteLink, HcTarget } from "./hc-machines.ts";
import { serveMeshOffers } from "./offer-doc.ts";
import { publishMeshStatusOnCore } from "./status-publisher.ts";
import { startCoreFeed } from "../push/core-feed.ts";
import type { PushService } from "../push/push-service.ts";

/** Far below HcConnection's 10 s default, so only a deadline that reached the connect can end it in time. */
const DEADLINE_MS = 50;
const core: HcTarget = { hc: "hc", handshakeTimeoutMs: DEADLINE_MS };

/** An `hc connect` child that takes the hello and never answers it. */
function silentChild(): ChildByteLink {
  const closes = new Set<(error: Error | undefined) => void>();
  let open = true;
  return {
    pid: 0,
    kill: () => undefined,
    send: () => undefined,
    onData: () => () => undefined,
    onClose: (listener) => {
      closes.add(listener);
      return () => closes.delete(listener);
    },
    close: () => {
      if (!open) return;
      open = false;
      for (const listener of closes) listener(undefined);
    },
  };
}

function logged(match: (line: string) => boolean): { log: (line: string) => void; line: Promise<string> } {
  const { promise, resolve } = Promise.withResolvers<string>();
  return { log: (line) => (match(line) ? resolve(line) : undefined), line: promise };
}

// Each test's own timeout is far below the 10 s default: a writer that ignores the configured deadline times out here.
const WITHIN_MS = 2_000;

test(
  "the mesh status publisher's connect ends at the host's configured hello deadline (#1011)",
  async () => {
    const { log, line } = logged((text) => text.startsWith("host: cannot write this host's mesh status"));
    const publisher = publishMeshStatusOnCore(core, () => undefined, "self", log, silentChild, 3_600_000);
    try {
      expect(await line).toContain("HcHandshakeTimeoutError");
    } finally {
      await publisher.stop();
    }
  },
  WITHIN_MS,
);

test(
  "the mesh offer service's connect ends at the host's configured hello deadline (#1011)",
  async () => {
    const { log, line } = logged((text) => text.startsWith("mesh offer:"));
    const service = serveMeshOffers(
      core,
      log,
      () => () => undefined,
      () => Promise.reject(new Error("no offer in this test")),
      silentChild,
    );
    try {
      expect(await line).toContain("HcHandshakeTimeoutError");
    } finally {
      await service.stop();
    }
  },
  WITHIN_MS,
);

test(
  "the push core feed's connect ends at the host's configured hello deadline (#1011)",
  async () => {
    const { log, line } = logged((text) => text.startsWith("push: cannot follow this host's core"));
    const service = { attach: () => undefined } as unknown as PushService;
    const feed = startCoreFeed(core, service, log, silentChild);
    try {
      expect(await line).toContain("HcHandshakeTimeoutError");
    } finally {
      await feed.stop();
    }
  },
  WITHIN_MS,
);
