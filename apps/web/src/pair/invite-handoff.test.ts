import { expect, test } from "bun:test";
import { carryInvite, desktopPasteInvite, pasteInvite } from "./invite-handoff.ts";

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
  const pasted = await pasteInvite(
    {
      readText: async () => clipboard,
      writeText: async (text) => {
        clipboard = text;
      },
    },
    null,
  );
  expect(pasted).toBe("https://example.test/pair#invite");
  expect(clipboard).toBe("");
});

test("a clipboard read refusal says to paste by hand, without consuming an invite", async () => {
  let writes = 0;
  await expect(
    pasteInvite(
      {
        readText: async () => {
          throw new Error("Read permission denied.");
        },
        writeText: async () => {
          writes += 1;
        },
      },
      null,
    ),
  ).rejects.toThrow("Ctrl+V");
  expect(writes).toBe(0);
});

test("in the desktop app the shell reads the invite, never the page (#2656)", async () => {
  let clipboard = "https://example.test/pair#invite";
  const shell = { doriface: { pasteInvite: async () => ({ link: "doriface://pair#invite" }) } };
  const pasted = await pasteInvite(
    {
      readText: async () => {
        throw new Error("the page may not read the clipboard");
      },
      writeText: async (text) => {
        clipboard = text;
      },
    },
    desktopPasteInvite(shell),
  );
  expect(pasted).toBe("doriface://pair#invite");
  expect(clipboard).toBe("");
});

const refusing = (refused: string) => desktopPasteInvite({ doriface: { pasteInvite: async () => ({ refused }) } });

test("a shell refusal says why, and a browser has no shell to ask", async () => {
  await expect(refusing("not-invite")?.() ?? Promise.resolve()).rejects.toThrow("no Doriterm invite link");
  await expect(refusing("gesture")?.() ?? Promise.resolve()).rejects.toThrow("click Paste invite");
  expect(desktopPasteInvite({})).toBeNull();
});
