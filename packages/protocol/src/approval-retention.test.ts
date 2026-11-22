import { expect, test } from "bun:test";
import { answerApproval, approvalClock, CLAIM_TTL_MS, readApprovalRecord } from "./approval-answer.ts";
import { approvalKey, markApproval } from "./approval-prompt.ts";
import { type ApprovalOutcome, type ApprovalRecord, readRecords, update } from "./approval-records.ts";
import { MemoryApprovalCore } from "./testing/approval-core.ts";
import { CLAUDE_PROMPT_SCREEN } from "./testing/approval-screens.ts";
import { ALLOW, CLAUDE_BLOCKED, DENY, terminalAt } from "./testing/approval-terminal.ts";

const terminal = terminalAt("t3", CLAUDE_BLOCKED);
const owner = { by: "phone", client: "a" };
const peer = { by: "tablet", client: "b" };
const history = (outcome: ApprovalOutcome, firstPrompt = "other-0"): ApprovalRecord[] =>
  Array.from({ length: 16 }, (_, i) => ({
    ...peer,
    prompt: i === 0 ? firstPrompt : `other-${i}`,
    attempt: `attempt-${i}`,
    answer: "deny",
    atMs: -1_000_000,
    outcome,
  }));

test("history pressure during a screen read cannot give a second answer the live claim", async () => {
  const stalled = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class StalledScreen extends MemoryApprovalCore {
    override async screen(address: string): Promise<string> {
      const screen = await super.screen(address);
      setImmediate(stalled.resolve); // The parallel document reply has completed by this turn.
      await release.promise;
      return screen;
    }
  }
  const core = new StalledScreen(terminal, CLAUDE_PROMPT_SCREEN);
  const mark = markApproval(terminal, CLAUDE_PROMPT_SCREEN);
  if (!mark) throw new Error("fixture did not mark");
  const clocks = { clock: approvalClock(() => 0), wall: () => 0 };
  const first = answerApproval(core, mark, ALLOW, owner, 0, clocks);
  await stalled.promise;
  try {
    const other = history("stale");
    await update(core, mark.terminal, (records) => [...records, ...other.slice(0, -1)]);
    await update(core, mark.terminal, (records) => [...records, ...other.slice(-1)]);
    expect(await readApprovalRecord(core, mark)).toMatchObject({ client: owner.client, outcome: "claimed" });
    expect((await readRecords(core, mark.terminal)).records).toHaveLength(16);
    expect(await answerApproval(core, mark, DENY, peer, 0)).toMatchObject({ kind: "lost", record: owner });
    expect(core.pressed).toEqual([]);
  } finally {
    release.resolve();
    await first;
  }
  expect(core.pressed).toEqual([{ address: "t3", keys: ["1"] }]);
  expect(await readApprovalRecord(core, mark)).toMatchObject({ client: owner.client, outcome: "sent" });
});

test("a full document refuses a new claim until a slot lapses on the writer's own clock", async () => {
  const core = new MemoryApprovalCore(terminal, CLAUDE_PROMPT_SCREEN);
  const mark = markApproval(terminal, CLAUDE_PROMPT_SCREEN);
  if (!mark) throw new Error("fixture did not mark");
  const otherMark = { ...mark, turn: mark.turn + 1 };
  const full = history("claimed", approvalKey(otherMark));
  await update(core, mark.terminal, () => full);
  let now = 0;
  const clock = approvalClock(() => now);
  const answer = () => answerApproval(core, mark, ALLOW, owner, now, { clock });
  await expect(answer()).rejects.toThrow("full of live claims");
  expect((await readRecords(core, mark.terminal)).records).toEqual(full);
  expect(core.pressed).toEqual([]);
  now = CLAIM_TTL_MS;
  // Trimming history watched this claim for eviction. A first answer to its prompt still starts its own watch.
  expect(await answerApproval(core, otherMark, ALLOW, owner, now, { clock })).toMatchObject({ kind: "lost" });
  expect(await answer()).toEqual({ kind: "sent" });
  const { records } = await readRecords(core, mark.terminal);
  expect(records.slice(0, -1)).toEqual(full.slice(1));
  expect(records.at(-1)).toMatchObject({ client: owner.client, outcome: "sent" });
});
