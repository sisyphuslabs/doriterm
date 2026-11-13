import { describe, expect, test } from "bun:test";
import { afterLeaving, noteLeaving } from "./leaving-attach.ts";

/** A promise the test settles by hand, so each step's order is the test's, not the clock's. */
function held<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Whether `promise` has settled once every queued reaction has run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise<void>((next) => setImmediate(next));
  return done;
}

describe("an attach left by a gone view (#2475)", () => {
  test("a terminal no gone view left an attach on is not held", async () => {
    expect(await settled(afterLeaving({}, "t1"))).toBe(true);
  });

  test("the next view waits until the gone view's attach is answered", async () => {
    const connection = {};
    const gone = held();
    noteLeaving(connection, "t1", gone.promise);
    const waiting = afterLeaving(connection, "t1");
    expect(await settled(waiting)).toBe(false);
    gone.resolve();
    expect(await settled(waiting)).toBe(true);
  });

  test("an attach that fails releases the wait too, so the next view never hangs on it", async () => {
    const connection = {};
    const gone = held();
    noteLeaving(connection, "t1", gone.promise);
    const waiting = afterLeaving(connection, "t1");
    gone.reject(new Error("refused"));
    expect(await settled(waiting)).toBe(true);
  });

  test("two gone views in a row: the wait holds until both are answered", async () => {
    const connection = {};
    const first = held();
    const second = held();
    noteLeaving(connection, "t1", first.promise);
    noteLeaving(connection, "t1", second.promise);
    const waiting = afterLeaving(connection, "t1");
    second.resolve();
    expect(await settled(waiting)).toBe(false);
    first.resolve();
    expect(await settled(waiting)).toBe(true);
  });

  test("other terminals and other connections are not held by it", async () => {
    const connection = {};
    noteLeaving(connection, "t1", held().promise);
    expect(await settled(afterLeaving(connection, "t2"))).toBe(true);
    expect(await settled(afterLeaving({}, "t1"))).toBe(true);
  });

  test("once answered, the entry is cleared and a later view is not held", async () => {
    const connection = {};
    const gone = held();
    noteLeaving(connection, "t1", gone.promise);
    gone.resolve();
    await settled(afterLeaving(connection, "t1"));
    expect(await settled(afterLeaving(connection, "t1"))).toBe(true);
  });
});
