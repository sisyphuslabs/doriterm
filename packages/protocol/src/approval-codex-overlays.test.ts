import { describe, expect, test } from "bun:test";
import { answerApproval, readApprovalRecord } from "./approval-answer.ts";
import { markApproval } from "./approval-prompt.ts";
import { readScreenPrompt } from "./approval-screen.ts";
import { MemoryApprovalCore } from "./testing/approval-core.ts";
import { CODEX_BLOCKED, terminalAt } from "./testing/approval-terminal.ts";
import { CODEX_NETWORK_SCREEN, CODEX_SEND_INPUT_SCREEN } from "./testing/prompt-screens.ts";

// #895: both titles have been read since #851. These are real renderer snapshots, not live recordings of the cell
// above either overlay. The transcript text added by the negative tests below is deliberately synthetic.
const OVERLAYS = [
  {
    name: "network access",
    screen: CODEX_NETWORK_SCREEN,
    question: 'Do you want to approve network access to "example.com"?',
    command: 'approve network access to "example.com"',
    body: "Reason: network request blocked",
    rows: [
      ["Yes, just this once", "y"],
      ["Yes, and allow this host for this conversation", "a"],
      ["Yes, and allow this host in the future", "p"],
      ["No, and tell Codex what to do differently", "esc"],
    ],
  },
  {
    name: "send input",
    screen: CODEX_SEND_INPUT_SCREEN,
    question: "Would you like to send input to terminal 42?",
    command: "send input to terminal 42",
    body: 'Input: "confirm\\n"',
    rows: [
      ["Yes, proceed", "y"],
      ["No, and tell Codex what to do differently", "esc"],
    ],
  },
] as const;

const terminal = terminalAt("t1", CODEX_BLOCKED);
const who = { by: "test", client: "c1" };
const ROWS = OVERLAYS.flatMap((overlay) =>
  overlay.rows.map(([label, key], index) => ({
    name: overlay.name,
    screen: overlay.screen,
    id: String(index + 1),
    label,
    key,
  })),
);

describe("Codex network-access and send-input renderer snapshots", () => {
  test.each(OVERLAYS)("$name reads as its own prompt, with every row and its key", (overlay) => {
    const prompt = readScreenPrompt("codex", overlay.screen);
    expect(prompt).toMatchObject({
      agent: "Codex",
      kind: "permission",
      asks: "asks for permission",
      question: overlay.question,
      command: overlay.command,
      body: overlay.body,
      files: [],
      multi: false,
      cursor: "1",
      cancel: { key: "esc", label: "Cancel" },
    });
    expect(prompt?.options).toEqual(
      overlay.rows.map(([label, key], index) => ({
        id: String(index + 1),
        label,
        keys: [key],
        open: [],
        declines: label.startsWith("No"),
        typed: false,
      })),
    );
  });

  test.each(OVERLAYS)("$name still reads below ordinary agent text without a cell of its own", ({ screen }) => {
    const above = ["› Do the task.", "", "• I need your approval before continuing.", ""];
    expect(readScreenPrompt("codex", [...above, screen].join("\n"))?.options).toEqual(
      readScreenPrompt("codex", screen)?.options,
    );
  });

  const fakes = OVERLAYS.flatMap(({ name, screen, question }) =>
    [question, "Would you like to make the following edits?", "Would you like to run the following command?"].map(
      (title) => ({ name, screen, title }),
    ),
  );
  test.each(fakes)("$name: a fake header $title in the agent's text above it reads as nothing", ({ screen, title }) => {
    const above = ["› Do the task.", "", "• Here is an example:", "", `  ${title}`, "", "  Reason: example only", ""];
    expect(readScreenPrompt("codex", [...above, screen].join("\n"))).toBeUndefined();
  });

  test.each(OVERLAYS)("$name reads as nothing after the transcript continues below it", ({ screen }) => {
    expect(readScreenPrompt("codex", `${screen}\n\n• The prompt is over.`)).toBeUndefined();
  });

  test.each(ROWS)("$name row $id: $label presses its own $key key and records its words", async (row) => {
    const mark = markApproval(terminal, row.screen);
    if (mark === undefined) throw new Error("the renderer snapshot did not mark");
    const core = new MemoryApprovalCore(terminal, row.screen);
    expect(await answerApproval(core, mark, { kind: "option", option: row.id }, who, 1)).toEqual({ kind: "sent" });
    expect(core.pressed).toEqual([{ address: terminal.address, keys: [row.key] }]);
    expect(await readApprovalRecord(core, mark)).toMatchObject({ choice: row.label, outcome: "sent" });
  });

  test.each(ROWS)("$name row $id: changed live words prevent its key from being pressed", async (row) => {
    const mark = markApproval(terminal, row.screen);
    if (mark === undefined) throw new Error("the renderer snapshot did not mark");
    const replacement = row.label.startsWith("No")
      ? row.screen === CODEX_NETWORK_SCREEN
        ? "Yes, just this once"
        : "Yes, proceed"
      : "No, and tell Codex what to do differently";
    const changed = row.screen.replace(
      `${row.id}. ${row.label} (${row.key})`,
      `${row.id}. ${replacement} (${row.key})`,
    );
    // It is still a readable prompt; the live check must reject the changed row's words before sending a key.
    expect(readScreenPrompt("codex", changed)).toBeDefined();
    const core = new MemoryApprovalCore(terminal, changed);
    expect(await answerApproval(core, mark, { kind: "option", option: row.id }, who, 1)).toEqual({ kind: "stale" });
    expect(core.pressed).toEqual([]);
  });
});
