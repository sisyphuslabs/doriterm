import { describe, expect, test } from "bun:test";
import { removeThenRead } from "./use-machines.ts";

describe("a machine's remove settles on hc's machine.rm alone (#2503 review)", () => {
  test("a remove hc made resolves when the read after it fails; the read's error goes apart", async () => {
    const readError = new Error("machine.list timed out");
    const failed: unknown[] = [];
    const removed = removeThenRead(
      () => Promise.resolve({}),
      () => Promise.reject(readError),
      (cause) => void failed.push(cause),
    );
    expect(await removed).toBeUndefined();
    expect(failed).toEqual([readError]);
  });

  test("hc's refusal stays the remove's reason when the read after it fails too", async () => {
    const refused = new Error("no machine named box");
    const failed: unknown[] = [];
    const removed = removeThenRead(
      () => Promise.reject(refused),
      () => Promise.reject(new Error("machine.list timed out")),
      (cause) => void failed.push(cause),
    );
    await expect(removed).rejects.toBe(refused);
    expect(failed).toHaveLength(1);
  });

  test("the read runs once hc answered and before the remove settles, so the page drops the machine at once", async () => {
    const order: string[] = [];
    await removeThenRead(
      async () => void order.push("rm"),
      async () => void order.push("read"),
      () => undefined,
    );
    order.push("settled");
    expect(order).toEqual(["rm", "read", "settled"]);
  });
});
