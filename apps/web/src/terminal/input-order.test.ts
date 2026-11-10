import { expect, spyOn, test } from "bun:test";
import { inputOrder } from "./input-order.ts";
import type { TerminalInput } from "./terminal-view-props.ts";

/** An input order recording each write; `wrote(n)` settles once n writes have happened. */
function recorded() {
  const written: TerminalInput[] = [];
  const waiting: { count: number; resolve: () => void }[] = [];
  const order = inputOrder((data) => {
    written.push(data);
    for (const wait of waiting) if (written.length >= wait.count) wait.resolve();
  });
  const wrote = (count: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (written.length >= count) resolve();
    else waiting.push({ count, resolve });
    return promise;
  };
  return { order, written, wrote };
}

test("input with nothing pending is written at once", () => {
  const { order, written } = recorded();
  order.send("a");
  order.send("b");
  expect(written).toEqual(["a", "b"]);
});

test("a key sent while Ctrl+V's ^V is not known yet is written after it", async () => {
  const { order, written, wrote } = recorded();
  const vee = Promise.withResolvers<TerminalInput | null>();
  order.later(vee.promise);
  order.send("x");
  order.send("y");
  expect(written).toEqual([]);
  vee.resolve("\u0016");
  await wrote(3);
  expect(written).toEqual(["\u0016", "x", "y"]);
  order.send("z");
  await wrote(4);
  expect(written).toEqual(["\u0016", "x", "y", "z"]);
});

test("input that turns out to be none lets what waited behind it through, in order", async () => {
  const { order, written, wrote } = recorded();
  const first = Promise.withResolvers<TerminalInput | null>();
  const second = Promise.withResolvers<TerminalInput | null>();
  order.later(first.promise);
  order.send("a");
  order.later(second.promise);
  order.send("b");
  second.resolve("\u0016");
  first.resolve(null);
  await wrote(3);
  expect(written).toEqual(["a", "\u0016", "b"]);
});

test("a queued write that fails is reported, and the input behind it still goes out in order (#1988)", async () => {
  const reported = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const written: TerminalInput[] = [];
    const last = Promise.withResolvers<void>();
    const order = inputOrder((data) => {
      if (data === "boom") throw new Error("link closed");
      written.push(data);
      if (data === "b") last.resolve();
    });
    const vee = Promise.withResolvers<TerminalInput | null>();
    order.later(vee.promise);
    order.send("boom");
    order.send("a");
    order.send("b");
    vee.resolve("\u0016");
    await last.promise;
    expect(written).toEqual(["\u0016", "a", "b"]);
    expect(reported).toHaveBeenCalledWith("terminal input: Error: link closed");
  } finally {
    reported.mockRestore();
  }
});

test("input that rejects is reported and lets what waited behind it through (#1988)", async () => {
  const reported = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const { order, written, wrote } = recorded();
    const broken = Promise.withResolvers<TerminalInput | null>();
    order.later(broken.promise);
    order.send("a");
    broken.reject(new Error("no clipboard"));
    await wrote(1);
    expect(written).toEqual(["a"]);
    expect(reported).toHaveBeenCalledWith("terminal input: Error: no clipboard");
  } finally {
    reported.mockRestore();
  }
});
