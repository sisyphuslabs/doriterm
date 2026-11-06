import { expect, test } from "bun:test";
import { MoveQueue } from "./move-queue.ts";

test("a move starts only once the move before it is done", async () => {
  const queue = new MoveQueue();
  const first = Promise.withResolvers<void>();
  const order: string[] = [];
  const one = queue.run(async () => {
    order.push("first started");
    await first.promise;
    order.push("first done");
  });
  const two = queue.run(async () => {
    order.push("second started");
  });
  await Promise.resolve();
  expect(order).toEqual(["first started"]);
  first.resolve();
  await Promise.all([one, two]);
  expect(order).toEqual(["first started", "first done", "second started"]);
});

test("a move that throws fails its own caller, and the next move still runs (#780)", async () => {
  const queue = new MoveQueue();
  const failed = queue.run(() => Promise.reject(new Error("the gateway is not a URL")));
  let ran = false;
  const next = queue.run(async () => {
    ran = true;
  });
  await expect(failed).rejects.toThrow("the gateway is not a URL");
  await next;
  expect(ran).toBe(true);
  await queue.idle;
});
