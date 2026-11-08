import { describe, expect, test } from "bun:test";
import { type Entrant, type RaceClock, raceFastest } from "./fastest.ts";

/** A clock that moves only when the test says so; due timers run in order, each followed by its promise reactions. */
class ManualClock implements RaceClock {
  #now = 0;
  readonly #timers: { readonly at: number; readonly run: () => void; live: boolean }[] = [];

  now(): number {
    return this.#now;
  }

  after(ms: number, run: () => void): () => void {
    const timer = { at: this.#now + ms, run, live: true };
    this.#timers.push(timer);
    return () => {
      timer.live = false;
    };
  }

  async advanceTo(at: number): Promise<void> {
    await settled();
    const due = this.#timers.filter((timer) => timer.live && timer.at <= at).toSorted((x, y) => x.at - y.at)[0];
    if (due === undefined) {
      this.#now = at;
      return settled();
    }
    due.live = false;
    this.#now = due.at;
    due.run();
    return this.advanceTo(at);
  }
}

/** Lets every pending promise reaction run: the macrotask comes only after the microtask queue is empty. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A Room round trip in ms (`Infinity`: never answered), or a socket the relay closes before any answer. */
type Ping = number | { readonly closesAfter: number };

/** A fake relay socket: it opens when the test says, and the Room answers its ping `pingMs` later on the clock. */
class FakeSocket {
  readonly name: string;
  readonly #opened = Promise.withResolvers<string>();
  readonly #clock: ManualClock;
  readonly #ping: Ping;
  closed = false;

  constructor(name: string, clock: ManualClock, ping: Ping) {
    this.name = name;
    this.#clock = clock;
    this.#ping = ping;
  }

  open(): void {
    this.#opened.resolve(this.name);
  }

  fail(error: Error): void {
    this.#opened.reject(error);
  }

  get entrant(): Entrant<string> {
    return {
      opened: this.#opened.promise,
      roundTrip: () => {
        const start = this.#clock.now();
        const ping = this.#ping;
        return new Promise((resolve) => {
          if (typeof ping === "object") this.#clock.after(ping.closesAfter, () => resolve(Number.POSITIVE_INFINITY));
          else if (Number.isFinite(ping)) this.#clock.after(ping, () => resolve(this.#clock.now() - start));
          else this.#clock.after(1_500, () => resolve(Number.POSITIVE_INFINITY));
        });
      },
      discard: () => {
        this.closed = true;
      },
    };
  }
}

function race(
  clock: ManualClock,
  pings: readonly Ping[],
  options: { readonly signal?: AbortSignal } = {},
): {
  readonly sockets: FakeSocket[];
  readonly outcome: () => { winner?: string; error?: unknown; at?: number };
} {
  const sockets = pings.map((ms, i) => new FakeSocket(String.fromCharCode(97 + i), clock, ms));
  const result: { winner?: string; error?: unknown; at?: number } = {};
  raceFastest(
    sockets.map((socket) => socket.entrant),
    { graceMs: 150, clock, ...options },
  ).then(
    (winner) => Object.assign(result, { winner, at: clock.now() }),
    (error: unknown) => Object.assign(result, { error, at: clock.now() }),
  );
  return { sockets, outcome: () => result };
}

describe("best-of-N relay dial: picking the socket nearest the Room", () => {
  test("keeps the socket with the shortest round trip and closes the others, as soon as none can beat it", async () => {
    const clock = new ManualClock();
    const { sockets, outcome } = race(clock, [264, 199, 297]);
    for (const socket of sockets) socket.open();
    await clock.advanceTo(198);
    expect(outcome().winner).toBeUndefined();
    await clock.advanceTo(10_000);
    expect(outcome()).toEqual({ winner: "b", at: 199 });
    expect(sockets.map((socket) => socket.closed)).toEqual([true, false, true]);
  });

  test("a socket still waiting for its answer is given only as long as the best round trip so far", async () => {
    const clock = new ManualClock();
    const { sockets, outcome } = race(clock, [264, 199, 297]);
    sockets[0]?.open();
    sockets[2]?.open();
    await clock.advanceTo(40);
    sockets[1]?.open();
    await clock.advanceTo(10_000);
    // b answered at 239 in 199 ms; a and c had been waiting since 0, longer than 199, so neither could still beat it.
    expect(outcome()).toEqual({ winner: "b", at: 239 });
    expect(sockets.map((socket) => socket.closed)).toEqual([true, false, true]);
  });

  test("a socket that has not opened is waited for at most the grace after the first answer, and closed when it opens", async () => {
    const clock = new ManualClock();
    const { sockets, outcome } = race(clock, [264, 50]);
    sockets[0]?.open();
    await clock.advanceTo(10_000);
    expect(outcome()).toEqual({ winner: "a", at: 264 + 150 });
    sockets[1]?.open();
    await settled();
    expect(sockets[1]?.closed).toBe(true);
  });

  test("a socket that opens late and answers within the grace wins", async () => {
    const clock = new ManualClock();
    const { sockets, outcome } = race(clock, [264, 50]);
    sockets[0]?.open();
    await clock.advanceTo(300);
    sockets[1]?.open();
    await clock.advanceTo(10_000);
    expect(outcome()).toEqual({ winner: "b", at: 350 });
    expect(sockets[0]?.closed).toBe(true);
  });

  test("a socket that fails to open is left out", async () => {
    const clock = new ManualClock();
    const { sockets, outcome } = race(clock, [10, 200, 250]);
    sockets[0]?.fail(new Error("refused"));
    sockets[1]?.open();
    sockets[2]?.open();
    await clock.advanceTo(10_000);
    expect(outcome()).toEqual({ winner: "b", at: 200 });
  });

  test("when every socket fails to open, the first one's error is the dial's", async () => {
    const clock = new ManualClock();
    const { sockets, outcome } = race(clock, [10, 20]);
    sockets[1]?.fail(new Error("second"));
    sockets[0]?.fail(new Error("first"));
    await clock.advanceTo(10_000);
    expect(String(outcome().error)).toBe("Error: first");
  });

  test("an answered socket beats one the Room never answered, and with no answer at all the first opened is kept", async () => {
    const clock = new ManualClock();
    const answered = race(clock, [Number.POSITIVE_INFINITY, 400]);
    for (const socket of answered.sockets) socket.open();
    await clock.advanceTo(10_000);
    expect(answered.outcome().winner).toBe("b");

    const silent = race(clock, [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]);
    for (const socket of silent.sockets) socket.open();
    await clock.advanceTo(20_000);
    expect(silent.outcome().winner).toBe("a");
    expect(silent.sockets.map((socket) => socket.closed)).toEqual([false, true]);
  });

  test("a socket refused before any answer does not start the grace: the sockets still waiting are answered and kept", async () => {
    const clock = new ManualClock();
    const { sockets, outcome } = race(clock, [{ closesAfter: 20 }, 264, 199]);
    for (const socket of sockets) socket.open();
    await clock.advanceTo(10_000);
    expect(outcome()).toEqual({ winner: "c", at: 199 });
    expect(sockets.map((socket) => socket.closed)).toEqual([true, true, false]);
  });

  test("a refused socket is kept once no other socket is waiting for its answer", async () => {
    const clock = new ManualClock();
    const { sockets, outcome } = race(clock, [{ closesAfter: 20 }, { closesAfter: 30 }]);
    for (const socket of sockets) socket.open();
    await clock.advanceTo(10_000);
    expect(outcome()).toEqual({ winner: "a", at: 30 });
    expect(sockets.map((socket) => socket.closed)).toEqual([false, true]);
  });

  test("a socket that has not opened is waited for at most the grace after another was refused, and closed when it opens", async () => {
    // A network that drops traffic to another port leaves that socket opening until its connect timeout (#1437).
    const clock = new ManualClock();
    const { sockets, outcome } = race(clock, [{ closesAfter: 20 }, 50, 50]);
    sockets[0]?.open();
    await clock.advanceTo(10_000);
    expect(outcome()).toEqual({ winner: "a", at: 20 + 150 });
    sockets[1]?.open();
    await settled();
    expect(sockets[1]?.closed).toBe(true);
  });

  test("equal round trips keep the earlier socket", async () => {
    const clock = new ManualClock();
    const { sockets, outcome } = race(clock, [120, 120, 120]);
    for (const socket of sockets) socket.open();
    await clock.advanceTo(10_000);
    expect(outcome().winner).toBe("a");
  });

  test("cancelling rejects with the caller's reason and closes every socket, including ones that open afterwards", async () => {
    const clock = new ManualClock();
    const cancelled = new AbortController();
    const { sockets, outcome } = race(clock, [264, 199, 297], { signal: cancelled.signal });
    sockets[0]?.open();
    sockets[1]?.open();
    await clock.advanceTo(100);
    cancelled.abort(new Error("the person closed the tab"));
    await settled();
    expect(String(outcome().error)).toBe("Error: the person closed the tab");
    sockets[2]?.open();
    await clock.advanceTo(10_000);
    expect(sockets.map((socket) => socket.closed)).toEqual([true, true, true]);
  });
});
