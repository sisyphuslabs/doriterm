import { expect, test } from "bun:test";
import { RendererAnswers } from "./renderer-answers.ts";

const none = (): void => undefined;

/**
 * A terminal's root and its input field, dispatching focus and blur as the DOM does for an event that does not bubble:
 * capture listeners on the root, then the field's own listeners in the order they were added. The renderer adds its
 * listener when it is built (@wterm/dom's InputHandler, which gives a focus report from it), before the view can.
 */
function terminal(given: string[], answers: RendererAnswers) {
  const capture: ((event: Event) => void)[] = [];
  const own: ((event: Event) => void)[] = [];
  const add =
    (into: "root" | "field") =>
    (_type: string, listener: EventListenerOrEventListenerObject, captures?: boolean | AddEventListenerOptions) => {
      if (typeof listener !== "function") return;
      if (into === "root" && captures === true) capture.push(listener);
      if (into === "field") own.push(listener);
    };
  const root = { addEventListener: add("root"), removeEventListener: none } as unknown as EventTarget;
  const field = {
    addEventListener: add("field"),
    removeEventListener: none,
    dispatchEvent: () => true,
  } as unknown as EventTarget;
  // The renderer's listener on the field: a program that enabled focus reporting gets ESC [ I.
  own.push(() => given.push(answers.answering ? "answer \u001b[I" : "person \u001b[I"));
  const stop = answers.focusReportsOf(root, field);
  const focus = (): void => {
    const event = { type: "focus", target: field } as unknown as Event;
    for (const listener of capture) listener(event);
    for (const listener of own) listener(event);
  };
  return { focus, stop };
}

test("a focus report the renderer gives as its field gains focus is its own, not the person typing (#2794)", () => {
  const given: string[] = [];
  const answers = new RendererAnswers();
  const { focus } = terminal(given, answers);
  focus();
  expect(given).toEqual(["answer \u001b[I"]);
  // Once the focus has gone through, input is the person's again.
  expect(answers.answering).toBe(false);
});

test("an answer given inside a write of output is the renderer's own; input outside one is the person's", () => {
  const answers = new RendererAnswers();
  const seen: boolean[] = [];
  answers.writing(() => seen.push(answers.answering));
  seen.push(answers.answering);
  expect(seen).toEqual([true, false]);
});

test("a write that throws still ends: later input is the person's", () => {
  const answers = new RendererAnswers();
  expect(() =>
    answers.writing(() => {
      throw new Error("renderer gone");
    }),
  ).toThrow("renderer gone");
  expect(answers.answering).toBe(false);
});
