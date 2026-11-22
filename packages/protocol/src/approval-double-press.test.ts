// The double-press probes from the security delta review of #237 at 06191803 (P1-P5), kept as regression tests: each
// one pressed the agent's key twice (or held a dead claim for a whole clock skew) there. They use only names that
// existed at 06191803, so they run against it; a client's own clock is passed as a plain object.
import { describe, expect, test } from "bun:test";
import { answerApproval, CLAIM_TTL_MS, readApprovalRecord } from "./approval-answer.ts";
import { markApproval } from "./approval-prompt.ts";
import { MemoryApprovalCore } from "./testing/approval-core.ts";
import { CLAUDE_PROMPT_SCREEN } from "./testing/approval-screens.ts";
import { ALLOW, CLAUDE_BLOCKED, DENY, terminalAt } from "./testing/approval-terminal.ts";

const phone = { by: "phone", client: "phone-1" };
const laptop = { by: "laptop", client: "laptop-1" };
const ownClock = (start = 0) => {
  const clock = { at: start, now: () => clock.at, firstSeen: new Map<string, number>() };
  return clock;
};

function asking<C extends MemoryApprovalCore>(make: (terminal: ReturnType<typeof terminalAt>) => C) {
  const terminal = terminalAt("t3", CLAUDE_BLOCKED, { statusMs: 27_091, turn: 1 });
  const mark = markApproval(terminal, CLAUDE_PROMPT_SCREEN);
  if (mark === undefined) throw new Error("fixture did not mark");
  return { core: make(terminal), mark };
}
const plain = (terminal: ReturnType<typeof terminalAt>) => new MemoryApprovalCore(terminal, CLAUDE_PROMPT_SCREEN);

/** A core whose next key press waits until released: a link that stalls with the key on its way. */
class StalledKeysCore extends MemoryApprovalCore {
  stall: PromiseWithResolvers<void> | undefined;
  readonly stalled = Promise.withResolvers<void>();
  override async keys(address: string, keys: readonly string[]): Promise<void> {
    const stall = this.stall;
    if (stall !== undefined) {
      this.stall = undefined;
      this.stalled.resolve();
      await stall.promise;
    }
    return super.keys(address, keys);
  }
}

/** A core whose first key press lands but whose reply is lost: the call throws after the agent got the key. */
class LostReplyCore extends MemoryApprovalCore {
  lose = true;
  override async keys(address: string, keys: readonly string[]): Promise<void> {
    await super.keys(address, keys);
    if (!this.lose) return;
    this.lose = false;
    throw new Error("keys: the reply was lost");
  }
}

describe("one key press per prompt, whatever the clocks, links and ids", () => {
  test("P1: two answers at once under one client id (a device's worker and page) press once", async () => {
    const { core, mark } = asking(plain);
    await Promise.all([
      answerApproval(core, mark, DENY, phone, 1_000),
      answerApproval(core, mark, ALLOW, phone, 1_000),
    ]);
    expect(core.pressed).toHaveLength(1);
  });

  test("P2: a claimer whose clock runs CLAIM_TTL_MS behind still holds the prompt against another device", async () => {
    const { core, mark } = asking(plain);
    await Promise.all([
      answerApproval(core, mark, ALLOW, phone, 0),
      answerApproval(core, mark, ALLOW, laptop, CLAIM_TTL_MS + 1),
    ]);
    expect(core.pressed).toHaveLength(1);
  });

  test("P3: a winner whose key press stalls is not overtaken by a device that has watched its claim for less than CLAIM_TTL_MS", async () => {
    const { core, mark } = asking((terminal) => new StalledKeysCore(terminal, CLAUDE_PROMPT_SCREEN));
    core.stall = Promise.withResolvers<void>();
    const release = core.stall;
    const first = answerApproval(core, mark, ALLOW, phone, 1_000);
    await core.stalled.promise;
    const second = await answerApproval(core, mark, ALLOW, laptop, 1_000 + CLAIM_TTL_MS + 1);
    release.resolve();
    await first;
    expect(second.kind).toBe("lost");
    expect(core.pressed).toHaveLength(1);
  });

  test("P4: a key press whose reply was lost holds the prompt, so trying again before the agent redraws presses nothing", async () => {
    const { core, mark } = asking((terminal) => new LostReplyCore(terminal, CLAUDE_PROMPT_SCREEN));
    const first = await answerApproval(core, mark, ALLOW, phone, 1_000);
    const again = await answerApproval(core, mark, ALLOW, phone, 2_000);
    expect(first.kind).not.toBe("sent");
    expect(again.kind).not.toBe("sent");
    expect(core.pressed).toHaveLength(1);
  });

  test("P5: a dead claim from a device whose clock runs ahead holds others off for CLAIM_TTL_MS of their own watch, not the skew", async () => {
    const { core, mark } = asking(plain);
    // The claimer's clock is 10 minutes ahead; its check fails and its `failed` record cannot be written.
    core.failNext("screen", 1);
    core.failNext("setDoc", 1, 1);
    await answerApproval(core, mark, ALLOW, phone, 10 * 60_000);
    const clock = ownClock();
    expect((await answerApproval(core, mark, ALLOW, laptop, 60_000, { clock })).kind).toBe("lost");
    clock.at = CLAIM_TTL_MS;
    expect((await answerApproval(core, mark, ALLOW, laptop, 60_000 + CLAIM_TTL_MS, { clock })).kind).toBe("sent");
    expect(core.pressed).toHaveLength(1);
  });
});

describe("the claimer's own fence", () => {
  test("a claim that lapses on the claimer's own clock before its key press presses nothing", async () => {
    const clock = ownClock();
    // The screen re-read takes longer than the claim may live: the press must not follow it.
    class SlowScreenCore extends MemoryApprovalCore {
      override async screen(address: string): Promise<string> {
        clock.at += CLAIM_TTL_MS;
        return super.screen(address);
      }
    }
    const { core, mark } = asking((terminal) => new SlowScreenCore(terminal, CLAUDE_PROMPT_SCREEN));
    expect(await answerApproval(core, mark, ALLOW, phone, 1, { clock })).toMatchObject({ kind: "failed" });
    expect(core.pressed).toEqual([]);
  });

  test("a claim another answer replaced before the press presses nothing", async () => {
    // Between the claim and the press, another answer's record takes the prompt (as after an expiry on its side): it
    // lands right after the claim's write, before any read the answer makes to check its claim.
    class OvertakenCore extends MemoryApprovalCore {
      overtaken = false;
      override async setDoc(
        name: string,
        on: string | undefined,
        value: Parameters<MemoryApprovalCore["setDoc"]>[2],
        version: number,
      ): Promise<"ok" | "conflict"> {
        const written = await super.setDoc(name, on, value, version);
        if (written === "ok" && !this.overtaken) {
          this.overtaken = true;
          const records: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "records") : [];
          const theirs = { by: "tablet", client: "tablet-1", attempt: "tablet-attempt" };
          const taken = (Array.isArray(records) ? records : []).map((record: unknown) =>
            Object.assign({}, typeof record === "object" && record !== null ? record : {}, theirs),
          );
          expect(await super.setDoc(name, on, { records: taken }, version + 1)).toBe("ok");
        }
        return written;
      }
    }
    const { core, mark } = asking((terminal) => new OvertakenCore(terminal, CLAUDE_PROMPT_SCREEN));
    expect(await answerApproval(core, mark, ALLOW, phone, 1, { clock: ownClock() })).toMatchObject({
      kind: "failed",
    });
    expect(core.pressed).toEqual([]);
  });
});

describe("#275: the claim's own guards, and the limit that needs hc", () => {
  test("a retake naming another client's attempt does not take over that client's live claim", async () => {
    const { core, mark } = asking((terminal) => new StalledKeysCore(terminal, CLAUDE_PROMPT_SCREEN));
    core.stall = Promise.withResolvers<void>();
    const release = core.stall;
    const first = answerApproval(core, mark, ALLOW, phone, 1, { clock: ownClock() });
    await core.stalled.promise;
    const theirs = (await readApprovalRecord(core, mark))?.attempt;
    if (theirs === undefined) throw new Error("the first answer's claim carries no attempt id");
    const second = await answerApproval(core, mark, ALLOW, laptop, 2, { clock: ownClock(), retake: theirs });
    release.resolve();
    await first;
    expect(second.kind).toBe("lost");
    expect(core.pressed).toHaveLength(1);
  });

  test("a claimer whose monotonic clock paused (a suspended page) presses nothing once its own wall clock says the claim lapsed", async () => {
    const clock = ownClock();
    const wall = { at: 1_000 };
    // The monotonic clock never moves; the screen re-read takes as long as a claim may live on the wall clock.
    class SuspendedCheckCore extends MemoryApprovalCore {
      override async screen(address: string): Promise<string> {
        wall.at += CLAIM_TTL_MS;
        return super.screen(address);
      }
    }
    const { core, mark } = asking((terminal) => new SuspendedCheckCore(terminal, CLAUDE_PROMPT_SCREEN));
    const result = await answerApproval(core, mark, ALLOW, phone, wall.at, { clock, wall: () => wall.at });
    expect(result.kind).toBe("failed");
    expect(core.pressed).toEqual([]);
  });

  // Known limit, herdrdev/herdr-core#122: a key already on the wire when its claim lapses still lands. Closing it needs a
  // conditional `terminal.keys` in hc; until then this case presses twice, and `test.failing` keeps that visible.
  test.failing(
    "Q1 (known limit, herdr-core#122): a key that stalls on the wire past another device's own CLAIM_TTL_MS watch is pressed twice",
    async () => {
      const { core, mark } = asking((terminal) => new StalledKeysCore(terminal, CLAUDE_PROMPT_SCREEN));
      const [a, b] = [ownClock(), ownClock()];
      core.stall = Promise.withResolvers<void>();
      const release = core.stall;
      const first = answerApproval(core, mark, ALLOW, phone, 1, { clock: a });
      await core.stalled.promise;
      expect((await answerApproval(core, mark, ALLOW, laptop, 2, { clock: b })).kind).toBe("lost");
      b.at += CLAIM_TTL_MS;
      await answerApproval(core, mark, ALLOW, laptop, 3, { clock: b });
      release.resolve();
      await first;
      expect(core.pressed).toHaveLength(1);
    },
  );
});
