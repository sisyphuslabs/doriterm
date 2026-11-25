import { expect, test } from "bun:test";
import { answerApproval, readApprovalRecord } from "./approval-answer.ts";
import { markApproval } from "./approval-prompt.ts";
import { MemoryApprovalCore } from "./testing/approval-core.ts";
import { CLAUDE_PROMPT_SCREEN } from "./testing/approval-screens.ts";
import { ALLOW, CLAUDE_BLOCKED, terminalAt } from "./testing/approval-terminal.ts";

const terminal = terminalAt("t3", CLAUDE_BLOCKED);
const phone = { by: "phone", client: "a" };
function asking() {
  const mark = markApproval(terminal, CLAUDE_PROMPT_SCREEN);
  if (!mark) throw new Error("fixture did not mark");
  return mark;
}

test.each(["stale", "failed"] as const)("a %s screen check does not wait for an unused fence", async (kind) => {
  const release = Promise.withResolvers<void>();
  class SlowFence extends MemoryApprovalCore {
    checked = false;
    override async doc(...args: Parameters<MemoryApprovalCore["doc"]>) {
      const beforeCheck = !this.checked;
      const doc = await super.doc(...args);
      if (beforeCheck && doc.version === 1) await release.promise;
      return doc;
    }
    override async screen(address: string) {
      try {
        return await super.screen(address);
      } finally {
        this.checked = true;
      }
    }
  }
  const core = new SlowFence(terminal, "");
  if (kind === "failed") core.failNext("screen");
  const mark = asking();
  const answer = answerApproval(core, mark, ALLOW, phone, 1);
  // Every other core reply resolves in microtasks. Does the answer finish before we release the unused read?
  const beforeRelease = await Promise.race([answer, new Promise<void>((resolve) => setImmediate(resolve))]);
  release.resolve();
  await answer;
  expect(beforeRelease).toMatchObject({ kind });
  expect(await readApprovalRecord(core, mark)).toMatchObject({ outcome: kind });
  expect(core.pressed).toEqual([]);
});

test.each([7, 8])("sent settlement after a stale fence version and %i fresh conflicts", async (conflicts) => {
  class MovingDoc extends MemoryApprovalCore {
    left = conflicts;
    override async keys(address: string, keys: readonly string[]) {
      await super.keys(address, keys);
      const { value, version } = await super.doc("approval.t3", undefined);
      await super.setDoc("approval.t3", undefined, value, version); // The cached fence version is stale.
    }
    override async setDoc(...args: Parameters<MemoryApprovalCore["setDoc"]>) {
      if (args[3] >= 2 && this.left-- > 0) return "conflict";
      return super.setDoc(...args);
    }
  }
  const core = new MovingDoc(terminal, CLAUDE_PROMPT_SCREEN);
  const mark = asking();
  expect(await answerApproval(core, mark, ALLOW, phone, 1)).toEqual({ kind: "sent" });
  expect(core.pressed).toHaveLength(1);
  expect(await readApprovalRecord(core, mark)).toMatchObject({ outcome: conflicts === 7 ? "sent" : "claimed" });
});
