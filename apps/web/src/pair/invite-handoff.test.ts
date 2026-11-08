import { expect, test } from "bun:test";
import { pasteInvite, carryInvite } from "./invite-handoff.ts";

test("carrying an invite copies only its link without performing a join", async () => {
  let copied = "";
  await carryInvite("https://example.test/pair#invite", {
    writeText: async (text) => {
      copied = text;
    },
  });
  expect(copied).toBe("https://example.test/pair#invite");
});

test("Paste invite clears the clipboard after reading it", async () => {
  let clipboard = "https://example.test/pair#invite";
  const pasted = await pasteInvite({
    readText: async () => clipboard,
    writeText: async (text) => {
      clipboard = text;
    },
  });
  expect(pasted).toBe("https://example.test/pair#invite");
  expect(clipboard).toBe("");
});

test("a clipboard read refusal is shown without consuming an invite", async () => {
  let writes = 0;
  await expect(
    pasteInvite({
      readText: async () => {
        throw new Error("permission denied");
      },
      writeText: async () => {
        writes += 1;
      },
    }),
  ).rejects.toThrow("permission denied");
  expect(writes).toBe(0);
});
