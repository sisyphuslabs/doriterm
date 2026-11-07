import { expect, test } from "bun:test";
import { typedSlot } from "./code.ts";
import type { SlotAnswer } from "./lookup.ts";
import { SlotLookups } from "./slot-lookups.ts";

const FOUND: SlotAnswer = {
  ok: true,
  record: { hostId: "h", noiseStaticPub: new Uint8Array(32), signPub: new Uint8Array(32) },
};
const REFUSED: SlotAnswer = { ok: false, reason: "No host is pairing with this code. It may have expired." };

/** A relay that records each slot it is asked for and answers `answer`. */
function relay(answer: SlotAnswer = REFUSED) {
  const asked: string[] = [];
  const answers: Promise<SlotAnswer>[] = [];
  const lookup = (slot: string): Promise<SlotAnswer> => {
    asked.push(slot);
    const answered = Promise.resolve(answer);
    answers.push(answered);
    return answered;
  };
  return { asked, answers, lookups: new SlotLookups("wss://relay.example", lookup) };
}

/** Types `code` into the field one character at a time, as the pair step reports each change. */
function typeEach(lookups: SlotLookups, code: string): void {
  for (let end = 1; end <= code.length; end++) lookups.typed(code.slice(0, end));
}

test("the slot is looked up once its third character is typed, and Pair asks the relay nothing more", async () => {
  const { asked, lookups } = relay({
    ok: true,
    record: { hostId: "h", noiseStaticPub: new Uint8Array(32), signPub: new Uint8Array(32) },
  });
  lookups.typed("AB");
  expect(asked).toEqual([]);
  typeEach(lookups, "AB3K 9XQZ");
  expect(asked).toEqual(["AB3"]);
  await lookups.offer("AB3K9XQZ");
  expect(asked).toEqual(["AB3"]);
});

test("editing inside the slot asks each slot once and never asks for a shifted one, so typing alone cannot spend the budget", () => {
  const { asked, lookups } = relay();
  typeEach(lookups, "AB3K");
  for (const text of ["A3K", "AB3K", "A3K", "AB3K", "AB3K9XQZ"]) lookups.typed(text);
  expect(asked).toEqual(["AB3"]);
});

test("a new slot typed from scratch is asked for, and the earlier slot's answer is kept for Pair", async () => {
  const { asked, lookups } = relay(FOUND);
  typeEach(lookups, "AB3");
  lookups.typed("");
  typeEach(lookups, "XY7");
  expect(asked).toEqual(["AB3", "XY7"]);
  await lookups.offer("AB3K9XQZ");
  expect(asked).toEqual(["AB3", "XY7"]);
});

test("a refused lookup is asked again by Pair, as a second Pair always asked", async () => {
  const { asked, answers, lookups } = relay();
  typeEach(lookups, "AB3K9XQZ");
  await Promise.all(answers);
  expect(await lookups.offer("AB3K9XQZ")).toEqual(REFUSED);
  expect(asked).toEqual(["AB3", "AB3"]);
});

test("a pasted code with no typing is looked up once by Pair", async () => {
  const { asked, lookups } = relay();
  await lookups.offer("AB3K9XQZ");
  expect(asked).toEqual(["AB3"]);
});

test("typedSlot reads a slot only from something that can still be a code", () => {
  expect(typedSlot("ab")).toBeNull();
  expect(typedSlot("ab3")).toBe("AB3");
  expect(typedSlot("ab3k 9xqz")).toBe("AB3");
  expect(typedSlot("AB3K9XQZ1")).toBeNull();
  expect(typedSlot("https://web.example/pair#x")).toBeNull();
});
