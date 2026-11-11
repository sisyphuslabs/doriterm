import { describe, expect, test } from "bun:test";
import type { ApprovalCore, ApprovalMark, Terminal } from "@doriface/protocol";
import {
  CLAUDE_AFTER_SCREEN,
  CLAUDE_PROMPT_SCREEN,
} from "../../../../packages/protocol/src/testing/approval-screens.ts";
import { CLAUDE_BLOCKED, terminalAt } from "../../../../packages/protocol/src/testing/approval-terminal.ts";
import { cardState, DRAW_WAITS_MS, type Pause, readCard, readKeyOf } from "./card-read.ts";
import { waitsOnKeys } from "./waiting-keys.ts";

/** A clock the test turns by hand: each pause the read asks for holds until the test releases it. */
function handClock() {
  const asked: number[] = [];
  const requests: PromiseWithResolvers<() => void>[] = [];
  const request = (index: number) => (requests[index] ??= Promise.withResolvers());
  const pause: Pause = (ms) => {
    const gate = Promise.withResolvers<void>();
    request(asked.length).resolve(gate.resolve);
    asked.push(ms);
    return gate.promise;
  };
  /** Resolves, with its release, once the read has asked for its `index`th pause (every read before it has finished). */
  const reached = (index: number) => request(index).promise;
  return { asked, pause, reached };
}

/** Lets each of the read's draw waits pass in order, after checking `before` ahead of each one. */
async function runOut(clock: ReturnType<typeof handClock>, before: () => void, index = 0): Promise<void> {
  if (index === DRAW_WAITS_MS.length) return;
  before();
  (await clock.reached(index))();
  return runOut(clock, before, index + 1);
}

/** An hc core whose screen shows each of `screens` in turn (the last one stays), or whose reads all fail. */
function coreShowing(terminal: Terminal, screens: readonly string[] | "dropped"): ApprovalCore {
  let next = 0;
  const screen = async () => {
    if (screens === "dropped") throw new Error("dropped");
    return screens[Math.min(next++, screens.length - 1)] ?? "";
  };
  return { terminal: async () => terminal, screen } as unknown as ApprovalCore;
}

/** One wait's card as useApproval keeps it: the dialog `readCard` drew and the read it finished, fed as the hook feeds them. */
function watch(terminal: Terminal, screens: readonly string[] | "dropped") {
  let shown: ApprovalMark | undefined;
  let read: string | undefined;
  const clock = handClock();
  const done = readCard(
    coreShowing(terminal, screens),
    terminal.address,
    new AbortController().signal,
    { drawn: (mark) => (shown = mark), finished: () => (read = readKeyOf(terminal)) },
    clock.pause,
  );
  const card = () => cardState(terminal, shown !== undefined, read);
  const strip = () => waitsOnKeys(terminal, card());
  return { card, strip, clock, done, read: () => read };
}

const claude = terminalAt("t3", CLAUDE_BLOCKED, { turn: 1 });

describe("the card a waiting agent's keys strip stands in for (#1555)", () => {
  test("reading while the screen is read, then shown once the dialog is drawn: no strip at any point", async () => {
    const { card, strip, clock, done } = watch(claude, [CLAUDE_AFTER_SCREEN, CLAUDE_PROMPT_SCREEN]);
    expect([card(), strip()]).toEqual(["reading", false]);
    (await clock.reached(0))();
    const drawWait = await clock.reached(1);
    expect([card(), strip()]).toEqual(["reading", false]);
    drawWait();
    await done;
    expect([card(), strip()]).toEqual(["shown", false]);
    expect(clock.asked).toEqual([0, 150]);
  });

  test("none once the draw waits run out with no dialog, and only then the strip", async () => {
    const { card, strip, clock, done } = watch(claude, [CLAUDE_AFTER_SCREEN]);
    await runOut(clock, () => expect([card(), strip()]).toEqual(["reading", false]));
    await done;
    expect(clock.asked).toEqual(DRAW_WAITS_MS);
    expect([card(), strip()]).toEqual(["none", true]);
  });

  test("none once a read that failed has finished, and the strip shows", async () => {
    const { card, strip, clock, done } = watch(claude, "dropped");
    expect([card(), strip()]).toEqual(["reading", false]);
    (await clock.reached(0))();
    await done;
    expect([card(), strip()]).toEqual(["none", true]);
  });

  test("the next turn's wait is read for again before the strip shows", async () => {
    const { clock, done, read } = watch(claude, [CLAUDE_AFTER_SCREEN]);
    await runOut(clock, () => undefined);
    await done;
    const next = terminalAt("t3", CLAUDE_BLOCKED, { turn: 2 });
    expect(cardState(next, false, read())).toBe("reading");
    expect(waitsOnKeys(next, cardState(next, false, read()))).toBe(false);
  });

  test("an agent whose dialogs this client cannot read has no card coming: the strip shows at once", () => {
    const other = terminalAt("t4", { app: "demo-agent", kind: "permission", state: "blocked" });
    expect(cardState(other, false, undefined)).toBe("none");
    expect(waitsOnKeys(other, cardState(other, false, undefined))).toBe(true);
  });
});
