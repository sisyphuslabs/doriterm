import { markApproval } from "@doriface/protocol";
import { ApprovalBanner, approvalAnnouncement } from "@doriface/ui";
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CODEX_BLOCKED, terminalAt } from "../../../../packages/protocol/src/testing/approval-terminal.ts";
import {
  CODEX_NETWORK_SCREEN,
  CODEX_SEND_INPUT_SCREEN,
} from "../../../../packages/protocol/src/testing/prompt-screens.ts";

describe("the web card for Codex renderer snapshots (#895)", () => {
  test.each([
    ["network access", CODEX_NETWORK_SCREEN],
    ["send input", CODEX_SEND_INPUT_SCREEN],
  ])("%s renders its prompt, every row and its key", (_, screen) => {
    const mark = markApproval(terminalAt("t1", CODEX_BLOCKED), screen);
    if (mark === undefined) throw new Error("the renderer snapshot did not mark");
    const state = { kind: "waiting" } as const;
    const markup = renderToStaticMarkup(createElement(ApprovalBanner, { prompt: mark.prompt, state }));
    expect(markup).toContain('aria-label="Codex asks for permission"');
    expect(markup).toContain(Bun.escapeHTML(mark.prompt.command));
    expect(markup).toContain(Bun.escapeHTML(mark.prompt.body));
    expect(markup.match(/data-option=/g)).toHaveLength(mark.prompt.options.length);
    for (const option of mark.prompt.options) {
      const row = new RegExp(`data-option="${option.id}"[\\s\\S]*?</button>`).exec(markup)?.[0];
      expect(row).toContain(Bun.escapeHTML(option.label));
      expect(row).toContain(`>${option.keys[0]}</span>`);
      expect(approvalAnnouncement(mark.prompt, state)).toContain(option.label);
    }
  });
});
