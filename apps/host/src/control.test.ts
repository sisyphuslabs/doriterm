import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlIsLive, controlSocketPath, type ControlListener, listenControl, requestControl } from "./control.ts";
import { parseRequest } from "./control-requests.ts";

let dir: string;
const listeners: ControlListener[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dh-ctl-"));
});
afterEach(() => {
  for (const listener of listeners.splice(0)) listener.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Sends raw bytes and resolves with everything the host wrote before closing. */
async function exchange(bytes: string): Promise<string> {
  const closed = Promise.withResolvers<string>();
  let text = "";
  const socket = await Bun.connect({
    unix: controlSocketPath(dir),
    socket: {
      data(_, chunk) {
        text += chunk.toString();
      },
      close() {
        closed.resolve(text);
      },
    },
  });
  socket.write(bytes);
  return Promise.race([
    closed.promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the host never answered")), 2000)),
  ]);
}

describe("control socket", () => {
  test("the control client asks on the first reply and returns only the final reply", async () => {
    listeners.push(listenControl(dir, async (_, __, question) => ({ confirmed: await question("123 456") })));
    const seen: string[] = [];
    const result = await requestControl(
      dir,
      {
        op: "mesh-join",
        target: "invite",
        yes: true,
        ask: true,
        fingerprint: undefined,
        name: undefined,
        relay: undefined,
      },
      async (code) => {
        seen.push(code);
        return true;
      },
    );
    expect(result).toEqual({ confirmed: true });
    expect(seen).toEqual(["123 456"]);
  });
  test("an older mesh-join request without ask cannot start a question", () => {
    expect(parseRequest('{"op":"mesh-join","target":"invite","yes":true}')).toEqual({
      op: "mesh-join",
      target: "invite",
      yes: true,
      ask: false,
      fingerprint: undefined,
      name: undefined,
      relay: undefined,
    });
  });

  test("the second control line answers the waiting join without dispatching a second request", async () => {
    let requests = 0;
    listeners.push(
      listenControl(dir, async (_, __, question) => {
        requests += 1;
        return { confirmed: await question("123 456") };
      }),
    );
    const first = Promise.withResolvers<string>();
    const closed = Promise.withResolvers<string>();
    let text = "";
    const socket = await Bun.connect({
      unix: controlSocketPath(dir),
      socket: {
        data(_, chunk) {
          text += chunk.toString();
          if (text.includes("\n")) first.resolve(text.slice(0, text.indexOf("\n")));
        },
        close() {
          closed.resolve(text);
        },
      },
    });
    socket.write('{"op":"mesh-join","target":"invite","ask":true,"yes":true}\n');
    expect(JSON.parse(await first.promise)).toEqual({ state: "code", code: "123 456" });
    expect(requests).toBe(1);
    socket.write('{"confirm":false}\n');
    expect(
      (await closed.promise)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { state: "code", code: "123 456" },
      { ok: true, result: { confirmed: false } },
    ]);
    expect(requests).toBe(1);
  });

  test("closing the control connection answers the waiting join false", async () => {
    const answer = Promise.withResolvers<boolean>();
    const code = Promise.withResolvers<void>();
    listeners.push(
      listenControl(dir, async (_, __, question) => {
        answer.resolve(await question("123 456"));
      }),
    );
    const socket = await Bun.connect({
      unix: controlSocketPath(dir),
      socket: {
        data() {
          code.resolve();
        },
      },
    });
    socket.write('{"op":"mesh-join","target":"invite","ask":true}\n');
    await code.promise;
    socket.end();
    expect(await answer.promise).toBe(false);
  });
  test("a request longer than the limit without a newline is refused, not buffered", async () => {
    listeners.push(listenControl(dir, () => Promise.resolve("handled")));
    const answer = await exchange("x".repeat(8192));
    expect(JSON.parse(answer)).toEqual({ ok: false, error: "request too large" });
  });

  // A reply past the socket's send buffer used to be cut short by `end(data)`, so the socket never closed and the client
  // waited forever. macOS's Unix-socket buffer is about 8 KB, so `mesh status` hung there on an ordinary mesh (#2387).
  test("a reply larger than the socket's send buffer reaches the client whole", async () => {
    const payload = "x".repeat(2_000_000);
    listeners.push(listenControl(dir, () => Promise.resolve(payload)));
    expect(await requestControl(dir, { op: "mesh-status" })).toBe(payload);
  });

  test("a live socket is reported as live, a stale or missing one is not", async () => {
    expect(await controlIsLive(dir)).toBe(false);
    const listener = listenControl(dir, () => Promise.resolve(undefined));
    try {
      expect(await controlIsLive(dir)).toBe(true);
    } finally {
      listener.stop();
    }
    expect(await controlIsLive(dir)).toBe(false);
  });

  test("a request's signal aborts once the connection that sent it closes", async () => {
    const asked = Promise.withResolvers<AbortSignal>();
    listeners.push(
      listenControl(dir, (_, closed) => {
        asked.resolve(closed);
        return new Promise(() => {});
      }),
    );
    const socket = await Bun.connect({ unix: controlSocketPath(dir), socket: { data() {} } });
    socket.write('{"op":"mesh-pending"}\n');
    const closed = await asked.promise;
    const aborted = new Promise<unknown>((resolve) => closed.addEventListener("abort", () => resolve(closed.reason)));
    socket.end();
    expect(String(await aborted)).toContain("the control connection closed");
  });
});
