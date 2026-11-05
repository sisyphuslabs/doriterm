import type { Page } from "@playwright/test";
import { E2E_HOST_PORT } from "./config.ts";
import { coreDoc, setCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { key, keysBar, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });

const HOST_INFO_DOC = "doriface-host";

// A chosen host OS without touching the shared e2e host: this page's reads use a document of the same length.
const FAKED_DOC = `${HOST_INFO_DOC.slice(0, -1)}x`;

async function readHostOS(page: Page, os: "darwin" | "linux"): Promise<void> {
  setCoreDoc(FAKED_DOC, { v: 1, os });
  await page.routeWebSocket(`ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`, (socket) => {
    const host = socket.connectToServer();
    socket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("latin1");
      const read = `"name":"${HOST_INFO_DOC}"`;
      host.send(text.includes(read) ? Buffer.from(text.replace(read, `"name":"${FAKED_DOC}"`), "latin1") : frame);
    });
    host.onMessage((message) => socket.send(message));
  });
}

test("the e2e host reports its real OS on its core, and its key bar matches it", async ({ page }) => {
  await openPhoneTerminal(page);
  // The host writes its OS once a client opens a pipe (#306): this page's.
  await expect.poll(() => coreDoc(HOST_INFO_DOC)).toMatchObject({ value: { v: 1, os: process.platform } });
  await expect(key(page, "Control")).toBeVisible();
  await expect(keysBar(page).getByRole("button", { name: "Command", exact: true })).toHaveCount(
    process.platform === "darwin" ? 1 : 0,
  );
});

for (const os of ["darwin", "linux"] as const) {
  test(`a host that reports ${os} gets its own modifiers and paste chord`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await readHostOS(page, os);
    const terminal = await openPhoneTerminal(page);
    await expect(keysBar(page).getByRole("button", { name: "Command", exact: true })).toHaveCount(
      os === "darwin" ? 1 : 0,
    );
    const modifier = key(page, os === "darwin" ? "Command" : "Control");
    await page.evaluate(() => navigator.clipboard.writeText("echo host-$((6+1))"));
    await modifier.click();
    await expect(modifier).toHaveAttribute("aria-pressed", "true");
    if (os === "linux") await key(page, "Shift").click();
    await page.keyboard.type("v");
    await expect(terminal).toContainText("echo host-$((6+1))", { timeout: 10_000 });
    await page.keyboard.type("\r");
    await expect(terminal).toContainText("host-7", { timeout: 10_000 });
  });
}
