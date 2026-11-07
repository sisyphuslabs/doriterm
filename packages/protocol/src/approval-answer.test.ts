import { describe, expect, test } from "bun:test";
import { answerApproval, approvalClock, CLAIM_TTL_MS, readApprovalRecord } from "./approval-answer.ts";
import { markApproval } from "./approval-prompt.ts";
import { MemoryApprovalCore } from "./testing/approval-core.ts";
import {
  CLAUDE_AFTER_SCREEN,
  CLAUDE_PROMPT_SCREEN,
  CLAUDE_SECOND_PROMPT_SCREEN,
  CODEX_PROMPT_SCREEN,
} from "./testing/approval-screens.ts";
import { ALLOW, CLAUDE_BLOCKED, CODEX_BLOCKED, DENY, terminalAt } from "./testing/approval-terminal.ts";

const phone = { by: "Safari on iOS", client: "phone-1" };
const laptop = { by: "Chrome on macOS", client: "laptop-1" };

function claudeAt(address: string) {
  const terminal = terminalAt(address, CLAUDE_BLOCKED, { statusMs: 27_091, turn: 1 });
  const mark = markApproval(terminal, CLAUDE_PROMPT_SCREEN);
  if (mark === undefined) throw new Error("fixture did not mark");
  return { core: new MemoryApprovalCore(terminal, CLAUDE_PROMPT_SCREEN), mark, terminal };
}

describe("answering a permission prompt", () => {
  test("Allow presses the agent's own key once and records who answered", async () => {
    const { core, mark } = claudeAt("t3");
    expect(await answerApproval(core, mark, ALLOW, phone, 5_000)).toEqual({ kind: "sent" });
    expect(core.pressed).toEqual([{ address: "t3", keys: ["1"] }]);
    expect(await readApprovalRecord(core, mark)).toMatchObject({
      answer: "allow",
      by: "Safari on iOS",
      client: "phone-1",
      atMs: 5_000,
      outcome: "sent",
    });
  });

  test("Deny presses the agent's own decline key", async () => {
    const terminal = terminalAt("t4", CODEX_BLOCKED, { statusMs: 29_143, turn: 1 });
    const mark = markApproval(terminal, CODEX_PROMPT_SCREEN);
    if (mark === undefined) throw new Error("fixture did not mark");
    const core = new MemoryApprovalCore(terminal, CODEX_PROMPT_SCREEN);
    expect(await answerApproval(core, mark, DENY, laptop, 1)).toEqual({ kind: "sent" });
    expect(core.pressed).toEqual([{ address: "t4", keys: ["esc"] }]);
  });

  test("stale: the dialog left the screen before the answer, so nothing is pressed", async () => {
    const { core, mark, terminal } = claudeAt("t3");
    core.show(terminal, CLAUDE_AFTER_SCREEN);
    expect(await answerApproval(core, mark, ALLOW, phone, 1)).toEqual({ kind: "stale" });
    expect(core.pressed).toEqual([]);
    expect((await readApprovalRecord(core, mark))?.outcome).toBe("stale");
  });

  test("stale: another prompt replaced it, so nothing is pressed for the old one", async () => {
    const { core, mark } = claudeAt("t3");
    core.show(terminalAt("t3", CLAUDE_BLOCKED, { statusMs: 30_512, turn: 2 }), CLAUDE_SECOND_PROMPT_SCREEN);
    expect(await answerApproval(core, mark, ALLOW, phone, 1)).toEqual({ kind: "stale" });
    expect(core.pressed).toEqual([]);
  });

  test("two devices racing on one prompt: exactly one answer reaches the agent, the other learns who won", async () => {
    const { core, mark } = claudeAt("t3");
    const [a, b] = await Promise.all([
      answerApproval(core, mark, ALLOW, phone, 10),
      answerApproval(core, mark, DENY, laptop, 11),
    ]);
    expect(core.pressed).toHaveLength(1);
    const outcomes = [a, b].map((outcome) => outcome.kind).toSorted();
    expect(outcomes).toEqual(["lost", "sent"]);
    const lost = a.kind === "lost" ? a : b;
    const winner = a.kind === "sent" ? phone : laptop;
    expect(lost.kind === "lost" && lost.record.by).toBe(winner.by);
  });

  test("a claim for a newer prompt of the same terminal does not erase the older prompt's record", async () => {
    const { core, mark } = claudeAt("t3");
    await answerApproval(core, mark, ALLOW, phone, 1);
    const next = terminalAt("t3", CLAUDE_BLOCKED, { statusMs: 30_512, turn: 2 });
    const nextMark = markApproval(next, CLAUDE_SECOND_PROMPT_SCREEN);
    if (nextMark === undefined) throw new Error("fixture did not mark");
    core.show(next, CLAUDE_SECOND_PROMPT_SCREEN);
    expect(await answerApproval(core, nextMark, DENY, laptop, 2)).toEqual({ kind: "sent" });
    expect((await readApprovalRecord(core, mark))?.by).toBe(phone.by);
    expect((await readApprovalRecord(core, nextMark))?.by).toBe(laptop.by);
  });

  test("the row the key picks on the live screen must carry the label the card showed, or nothing is pressed", async () => {
    const { core, mark } = claudeAt("t3");
    const options = mark.prompt.options.map((option) =>
      option.id === "1" ? { ...option, label: "Delete everything" } : option,
    );
    const shown = { ...mark, prompt: { ...mark.prompt, options } };
    expect(await answerApproval(core, shown, ALLOW, phone, 1)).toEqual({ kind: "stale" });
    expect(core.pressed).toEqual([]);
  });

  test("a terminal on an added machine keeps its claim on that machine's core", async () => {
    const { core, mark } = claudeAt("box/t3");
    await answerApproval(core, mark, ALLOW, phone, 1);
    expect(core.docNames()).toEqual(["box:approval.t3"]);
    expect(core.pressed).toEqual([{ address: "box/t3", keys: ["1"] }]);
  });
});

describe("a claim is only as true as what happened after it", () => {
  test("a failure between the claim and the key press records failed and presses nothing; the next answer goes through", async () => {
    const { core, mark } = claudeAt("t3");
    core.failNext("screen");
    expect(await answerApproval(core, mark, ALLOW, phone, 1)).toMatchObject({ kind: "failed" });
    expect(core.pressed).toEqual([]);
    expect((await readApprovalRecord(core, mark))?.outcome).toBe("failed");
    expect(await answerApproval(core, mark, ALLOW, laptop, 2)).toEqual({ kind: "sent" });
    expect(core.pressed).toEqual([{ address: "t3", keys: ["1"] }]);
    expect(await readApprovalRecord(core, mark)).toMatchObject({ by: laptop.by, outcome: "sent" });
  });

  test("while the key is being pressed the record still says claimed, not sent", async () => {
    const { core, mark } = claudeAt("t3");
    expect(await answerApproval(core, mark, ALLOW, phone, 1)).toEqual({ kind: "sent" });
    const atPress = JSON.stringify(core.docsAtPress[0]?.get(":approval.t3"));
    expect(atPress).toContain('"outcome":"claimed"');
    expect(atPress).not.toContain('"outcome":"sent"');
  });

  test("a key press that fails is recorded unknown, never sent, and holds the prompt for every answer", async () => {
    const { core, mark } = claudeAt("t3");
    core.failNext("keys");
    expect(await answerApproval(core, mark, ALLOW, phone, 1)).toMatchObject({ kind: "unknown" });
    expect((await readApprovalRecord(core, mark))?.outcome).toBe("unknown");
    expect(await answerApproval(core, mark, ALLOW, laptop, 2)).toMatchObject({ kind: "lost" });
  });

  test("when even the failure cannot be recorded, the same client's next answer waits CLAIM_TTL_MS on its own clock", async () => {
    const { core, mark } = claudeAt("t3");
    let now = 0;
    const clock = approvalClock(() => now);
    core.failNext("screen");
    core.failNext("doc", 1, 1);
    // The claim lands (its doc.get passes); the re-read throws; recording `failed` cannot read the document.
    expect(await answerApproval(core, mark, ALLOW, phone, 1, { clock })).toMatchObject({ kind: "failed" });
    expect((await readApprovalRecord(core, mark))?.outcome).toBe("claimed");
    expect(await answerApproval(core, mark, ALLOW, phone, 2, { clock })).toMatchObject({ kind: "lost" });
    now = CLAIM_TTL_MS;
    expect(await answerApproval(core, mark, ALLOW, phone, 3, { clock })).toEqual({ kind: "sent" });
    expect(core.pressed).toHaveLength(1);
  });

  test("a client that saw its own answer fail takes over exactly that claim at once, and nothing else does", async () => {
    const { core, mark } = claudeAt("t3");
    core.failNext("screen");
    core.failNext("doc", 1, 1);
    const failed = await answerApproval(core, mark, ALLOW, phone, 1);
    if (failed.kind !== "failed") throw new Error(`expected failed, got ${failed.kind}`);
    expect(await answerApproval(core, mark, ALLOW, phone, 2, { retake: "not-that-attempt" })).toMatchObject({
      kind: "lost",
    });
    expect(await answerApproval(core, mark, ALLOW, laptop, 2)).toMatchObject({ kind: "lost" });
    expect(await answerApproval(core, mark, ALLOW, phone, 3, { retake: failed.attempt })).toEqual({ kind: "sent" });
    expect(core.pressed).toHaveLength(1);
  });

  test("another client's live claim is not taken over, and it does not read as answered", async () => {
    const { core, mark } = claudeAt("t3");
    core.failNext("screen");
    core.failNext("doc", 1, 1);
    await answerApproval(core, mark, ALLOW, phone, 1_000);
    const taken = await answerApproval(core, mark, ALLOW, laptop, 1_000 + CLAIM_TTL_MS - 1);
    expect(taken).toMatchObject({ kind: "lost", record: { by: phone.by, outcome: "claimed" } });
    expect(core.pressed).toEqual([]);
  });

  test("a claim whose owner went away expires after CLAIM_TTL_MS of the observer's own watch", async () => {
    const { core, mark } = claudeAt("t3");
    let now = 0;
    const clock = approvalClock(() => now);
    core.failNext("screen");
    core.failNext("doc", 1, 1);
    await answerApproval(core, mark, ALLOW, phone, 1_000);
    expect(await answerApproval(core, mark, DENY, laptop, 1_000 + CLAIM_TTL_MS, { clock })).toMatchObject({
      kind: "lost",
    });
    now = CLAIM_TTL_MS - 1;
    expect(await answerApproval(core, mark, DENY, laptop, 0, { clock })).toMatchObject({ kind: "lost" });
    now = CLAIM_TTL_MS;
    expect(await answerApproval(core, mark, DENY, laptop, 0, { clock })).toEqual({ kind: "sent" });
    expect(core.pressed).toEqual([{ address: "t3", keys: ["esc"] }]);
    expect(await readApprovalRecord(core, mark)).toMatchObject({ by: laptop.by, answer: "deny", outcome: "sent" });
  });
});

describe("the same dialog asked again", () => {
  test("is a new prompt: answering the first does not answer it, and the old mark cannot press on it", async () => {
    const { core, mark } = claudeAt("t3");
    expect(await answerApproval(core, mark, ALLOW, phone, 1)).toEqual({ kind: "sent" });
    // The agent asks the identical command again: same dialog, a new turn and status_ms.
    const again = terminalAt("t3", CLAUDE_BLOCKED, { statusMs: 41_000, turn: 2 });
    core.show(again, CLAUDE_PROMPT_SCREEN);
    expect(await answerApproval(core, mark, ALLOW, laptop, 2)).toMatchObject({ kind: "lost" });
    const second = markApproval(again, CLAUDE_PROMPT_SCREEN);
    if (second === undefined) throw new Error("fixture did not mark");
    expect(await readApprovalRecord(core, second)).toBeUndefined();
    expect(await answerApproval(core, second, ALLOW, laptop, 3)).toEqual({ kind: "sent" });
    expect(core.pressed).toHaveLength(2);
  });
});
