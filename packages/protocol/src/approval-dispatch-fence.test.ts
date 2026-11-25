import { expect, test } from "bun:test";
import { answerApproval, approvalClock, CLAIM_TTL_MS, readApprovalRecord } from "./approval-answer.ts";
import { markApproval } from "./approval-prompt.ts";
import { update } from "./approval-records.ts";
import { MemoryApprovalCore } from "./testing/approval-core.ts";
import { CLAUDE_BLOCKED, terminalAt } from "./testing/approval-terminal.ts";
import { CLAUDE_QUESTION_SCREEN, CLAUDE_QUESTION_TYPING_SCREEN } from "./testing/prompt-screens.ts";

test.each(["keys", "paste"] as const)("a stalled screen reply cannot authorize %s after takeover", async (dispatch) => {
  const stalled = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class StalledScreen extends MemoryApprovalCore {
    override async screen(address: string): Promise<string> {
      const screen = await super.screen(address);
      if (screen === (dispatch === "keys" ? CLAUDE_QUESTION_SCREEN : CLAUDE_QUESTION_TYPING_SCREEN)) {
        // Let the alongside document reply finish while this screen reply remains in flight.
        setImmediate(stalled.resolve);
        await release.promise;
      }
      return screen;
    }
  }
  const terminal = terminalAt("t3", { ...CLAUDE_BLOCKED, kind: "question" });
  const core = new StalledScreen(terminal, CLAUDE_QUESTION_SCREEN);
  core.showAfterKeys(CLAUDE_QUESTION_TYPING_SCREEN);
  const mark = markApproval(terminal, CLAUDE_QUESTION_SCREEN);
  if (mark === undefined) throw new Error("fixture did not mark");
  let now = 0;
  // Each clock alone must stop dispatch, including when the page's monotonic clock pauses.
  const clock = approvalClock(() => (dispatch === "keys" ? now : 0));
  const wall = () => (dispatch === "paste" ? now : 0);
  const answer = answerApproval(
    core,
    mark,
    { kind: "text", option: "4", text: "test" },
    { by: "phone", client: "a" },
    0,
    { clock, wall, pause: () => Promise.resolve() },
  );
  await stalled.promise;
  const priorKeys = [...core.pressed];
  expect(priorKeys).toHaveLength(dispatch === "keys" ? 0 : 1);

  now = CLAIM_TTL_MS;
  // Model the observer's successful takeover in the shared document, without dispatching on its behalf.
  await update(core, mark.terminal, (records) =>
    records.map((record) => ({ ...record, by: "tablet", client: "b", attempt: "tablet-attempt" })),
  );
  release.resolve();
  const result = await answer;
  expect(core.pressed).toEqual(priorKeys);
  expect(core.sent).toEqual([]);
  expect(result.kind).toBe(dispatch === "keys" ? "failed" : "unknown");
  expect(await readApprovalRecord(core, mark)).toMatchObject({ client: "b", outcome: "claimed" });
});
