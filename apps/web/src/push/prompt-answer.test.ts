import type { PushHostLine } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { noticeOf } from "./notice-open.ts";
import { answerFromPage, whenVisible } from "./prompt-answer.ts";

/** A document whose visibility the test flips, firing visibilitychange as a browser does. */
/** A host that cannot be reached. */
const offline = async (): Promise<PushHostLine> => {
  throw new Error("offline");
};
const at = (search: string) => noticeOf(new URL(`https://app.example/${search}`));

function page(state: DocumentVisibilityState) {
  const listeners = new Set<() => void>();
  return {
    get visibilityState() {
      return state;
    },
    addEventListener: (_: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => void listeners.delete(listener),
    show() {
      state = "visible";
      for (const listener of listeners) listener();
    },
  };
}

describe("an answer from the page", () => {
  test("sends nothing while the page is hidden, and sends once it is visible", async () => {
    const doc = page("hidden");
    const sent: string[] = [];
    const done = answerFromPage(
      "t3",
      async () => {
        sent.push("allow");
        return { t: "answered", terminal: "t3" };
      },
      () => whenVisible(doc),
    );
    await Promise.resolve();
    expect(sent).toEqual([]);
    doc.show();
    expect(await done).toBe("answered");
    expect(sent).toEqual(["allow"]);
  });

  test.each([
    ["the host answered", { t: "answered", terminal: "t3" }, "answered"],
    ["the prompt had gone", { t: "stale", terminal: "t3" }, "stale"],
    ["the host refused", { t: "error", reason: "x" }, "failed"],
    ["the answer did not go through", { t: "failed", terminal: "t3", reason: "link dropped" }, "failed"],
    ["the key press may have landed", { t: "unknown", terminal: "t3" }, "unknown"],
  ] as const)("%s", async (_, reply: PushHostLine, phase) => {
    expect(
      await answerFromPage(
        "t3",
        async () => reply,
        async () => undefined,
      ),
    ).toBe(phase);
  });

  test("a host that cannot be reached sends nothing", async () => {
    expect(await answerFromPage("t3", offline, async () => undefined)).toBe("failed");
  });

  test("only answer=allow or answer=option:<id> in the address asks the page to answer", () => {
    expect(at("?notice=AAAAAAAAAAAAAAAAAAAAAA&host=h&answer=allow")?.answer).toEqual({ kind: "allow" });
    expect(at("?notice=AAAAAAAAAAAAAAAAAAAAAA&host=h&answer=option:2")?.answer).toEqual({
      kind: "option",
      option: "2",
    });
    expect(at("?notice=AAAAAAAAAAAAAAAAAAAAAA&host=h&answer=deny")?.answer).toBeUndefined();
    expect(at("?notice=AAAAAAAAAAAAAAAAAAAAAA&host=h&answer=option:x")?.answer).toBeUndefined();
    expect(at("?notice=AAAAAAAAAAAAAAAAAAAAAA&host=h")?.answer).toBeUndefined();
    // Deny arrives only from an app's notification (#705), which cannot answer by itself; it is no page answer.
    expect(at("?notice=AAAAAAAAAAAAAAAAAAAAAA&host=h&answer=deny")?.deny).toBe(true);
    expect(at("?notice=AAAAAAAAAAAAAAAAAAAAAA&host=h&answer=deny")?.answer).toBeUndefined();
    expect(at("?notice=AAAAAAAAAAAAAAAAAAAAAA&host=h&answer=allow")?.deny).toBe(false);
  });
});
