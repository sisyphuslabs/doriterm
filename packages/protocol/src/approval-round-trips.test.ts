import { describe, expect, test } from "bun:test";
import { answerApproval, readApprovalRecord } from "./approval-answer.ts";
import type { ApprovalCore } from "./approval-live.ts";
import { markApproval } from "./approval-prompt.ts";
import type { PromptReply } from "./approval-reply.ts";
import { MemoryApprovalCore } from "./testing/approval-core.ts";
import { CLAUDE_BLOCKED, terminalAt } from "./testing/approval-terminal.ts";
import * as screens from "./testing/prompt-screens.ts";

/** One turn of the event loop: every callback already due runs first. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Counts how many round trips to the core an answer waits on one after another (#2718). Every call is held until all
 * the calls the answer has in flight are held too; then they are answered together, as one round trip. On a core whose
 * every reply is slow (a loaded machine, a relay link), an answer takes this many replies' time before the card can say
 * it went through.
 */
async function roundTrips<T>(core: ApprovalCore, run: (counted: ApprovalCore) => Promise<T>) {
  const held: (() => void)[] = [];
  const trip =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await new Promise<void>((resolve) => held.push(resolve));
      return call(...args);
    };
  const counted: ApprovalCore = {
    terminal: trip((address) => core.terminal(address)),
    screen: trip((address) => core.screen(address)),
    keys: trip((address, keys) => core.keys(address, keys)),
    send: trip((address, text) => core.send(address, text)),
    doc: trip((name, on) => core.doc(name, on)),
    setDoc: trip((name, on, value, version) => core.setDoc(name, on, value, version)),
  };
  let done = false;
  const answer = run(counted).finally(() => (done = true));
  let trips = 0;
  // After a turn, every call the answer can make before its next reply is held: they are one round trip.
  const pump = async (): Promise<void> => {
    await nextTurn();
    if (done) return;
    if (held.length > 0) {
      trips += 1;
      for (const release of held.splice(0)) release();
    }
    return pump();
  };
  await pump();
  return { result: await answer, trips };
}

const phone = { by: "phone", client: "phone-1" };
const noWait = () => Promise.resolve();

function question() {
  const terminal = terminalAt("t3", { ...CLAUDE_BLOCKED, kind: "question" });
  const core = new MemoryApprovalCore(terminal, screens.CLAUDE_QUESTION_SCREEN);
  const mark = markApproval(terminal, screens.CLAUDE_QUESTION_SCREEN);
  if (mark === undefined) throw new Error("no prompt");
  return { core, mark };
}

describe("an answer waits on as few replies in a row as its checks allow (#2718)", () => {
  test("a row: claim (read, write), the live screen and the fence together, the key, then sent", async () => {
    const { core, mark } = question();
    const reply: PromptReply = { kind: "option", option: "2" };
    const { result, trips } = await roundTrips(core, (counted) => answerApproval(counted, mark, reply, phone, 1));
    expect(result).toEqual({ kind: "sent" });
    expect(trips).toBe(5);
    expect(await readApprovalRecord(core, mark)).toMatchObject({ choice: "SQLite", outcome: "sent" });
  });

  test("a typed answer: two more, the open row read with the fence, and the text", async () => {
    const { core, mark } = question();
    core.showAfterKeys(screens.CLAUDE_QUESTION_TYPING_SCREEN);
    const reply: PromptReply = { kind: "text", option: "4", text: "MySQL 8" };
    const { result, trips } = await roundTrips(core, (counted) =>
      answerApproval(counted, mark, reply, phone, 1, { pause: noWait }),
    );
    expect(result).toEqual({ kind: "sent" });
    expect(trips).toBe(7);
    expect(core.sent).toEqual([{ address: "t3", text: "MySQL 8" }]);
    expect(await readApprovalRecord(core, mark)).toMatchObject({ outcome: "sent" });
  });
});
