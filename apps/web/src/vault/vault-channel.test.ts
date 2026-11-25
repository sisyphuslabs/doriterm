import { describe, expect, test } from "bun:test";
import { localKeyholder, remoteKeyholder, serveKeyholder } from "@doriface/vault";
import { testDevice } from "../../../../packages/vault/src/testing.ts";
import { answerOn, callOver, type Port } from "./vault-channel.ts";

/** Two ends of a message channel that copy every message, as postMessage does. */
function pair(): readonly [Port, Port, unknown[]] {
  const seen: unknown[] = [];
  const page = new EventTarget();
  const worker = new EventTarget();
  const send = (to: EventTarget) => (message: unknown) => {
    const copy = structuredClone(message);
    seen.push(copy);
    queueMicrotask(() => to.dispatchEvent(new MessageEvent("message", { data: copy })));
  };
  const end = (self: EventTarget, other: EventTarget): Port => ({
    postMessage: send(other),
    addEventListener: (type, listener) => self.addEventListener(type, listener as EventListener),
  });
  return [end(page, worker), end(worker, page), seen];
}

describe("the vault worker's channel", () => {
  test("carries keyholder calls both ways while no message holds a key", async () => {
    const device = await testDevice();
    const [page, worker, seen] = pair();
    answerOn(worker, Promise.resolve(serveKeyholder(localKeyholder(device.deviceKey))));
    const holder = await remoteKeyholder(callOver(page));
    expect(holder.recipient).toBe(device.deviceKey.recipient);
    const created = await holder.generate(1);
    const wrap = await created.wrapFor(holder.recipient);
    expect(await holder.unwrap(wrap, 1, created.publicKey)).toBeDefined();
    const wire = JSON.stringify(seen, (_key, value: unknown) =>
      value instanceof Uint8Array ? new TextDecoder().decode(value) : value,
    );
    expect(wire).not.toContain("AGE-SECRET-KEY");
  });

  test("a refused call reaches the page as an error", async () => {
    const [page, worker] = pair();
    answerOn(worker, Promise.resolve(serveKeyholder(localKeyholder((await testDevice()).deviceKey))));
    await expect(callOver(page)({ op: "open", id: "nope", envelope: {} as never })).rejects.toThrow();
  });
});
