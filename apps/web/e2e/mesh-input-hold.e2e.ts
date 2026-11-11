import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { PRIVATE_RELAY_SKIP } from "./private-relay.ts";
import { routeRelaySockets } from "./relay-route.ts";

// #1489: keys typed into a terminal on another mesh member while that member's line is down. hc drops what is written to
// such a terminal meanwhile and keeps the stream open, so nothing failed as far as the page could tell. The page holds
// the keys, says so on the terminal, and sends them once, Ctrl+C first, when the machine is connected again; a hold that
// outlasts its limit is dropped and said to be not sent. Two real doriface-hosts behind the private relay under wrangler
// dev (web-mesh-hosts.ts); b's host process is stopped and started again on the same state, so its shell lives on.
test.skip(process.env["DORIFACE_RELAY_DIR"] === undefined, PRIVATE_RELAY_SKIP);
test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const HELPER = join(import.meta.dirname, "..", "..", "..", "tests", "relay", "support", "web-mesh-hosts.ts");
let helper: ChildProcess | undefined;
let reader: AsyncIterator<string> | undefined;
let relayUrl = "";
let machine = "";
let page: Page;
let terminal: Locator;

async function nextLine(prefix: string): Promise<string> {
  const next = await reader?.next();
  if (next === undefined || next.done === true) throw new Error(`mesh-hosts ended before a ${prefix.trim()} line`);
  return next.value.startsWith(prefix) ? next.value.slice(prefix.length) : nextLine(prefix);
}

async function ask(line: "STOP" | "START"): Promise<void> {
  helper?.stdin?.write(`${line}\n`);
  await nextLine(`${line === "STOP" ? "STOPPED" : "STARTED"}`);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  // Playwright sets FORCE_COLOR for its workers; wrangler would colour the line the helper waits for.
  const { FORCE_COLOR: _colour, ...inherited } = process.env;
  helper = spawn("bun", [HELPER], { stdio: ["pipe", "pipe", "inherit"], env: { ...inherited, NO_COLOR: "1" } });
  if (helper.stdout === null) throw new Error("mesh-hosts has no stdout");
  reader = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
  ({ relayUrl, machine } = JSON.parse(await nextLine("READY ")) as { relayUrl: string; machine: string });

  page = await (await browser.newContext({ serviceWorkers: "block" })).newPage();
  await routeRelaySockets(page, relayUrl);
  helper.stdin?.write("PAIR\n");
  await page.goto(`/pair${await nextLine("LINK ")}`);
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await expect(page.getByText("This device now reaches the host through the relay")).toBeVisible({ timeout: 60_000 });
  await page
    .getByRole("link", { name: "Open terminals" })
    .or(page.getByRole("button", { name: "Open terminals" }))
    .click();
  const row = page
    .getByRole("button", { name: /\bon-b\b/ })
    .filter({ hasText: machine })
    .first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  terminal = page.locator(`[data-terminal^="${machine}/"]:visible`).first();
  await expect(terminal).toContainText("$", { timeout: 30_000 });
  await terminal.click();
});

test.afterAll(async () => {
  await page?.context().close();
  const running = helper;
  if (running === undefined) return;
  running.kill("SIGTERM");
  await expect.poll(() => running.exitCode ?? running.signalCode, { timeout: 90_000 }).not.toBeNull();
});

/**
 * Starts a raw-mode reader in b's shell that keeps the first `count` bytes it receives in a file and returns that file:
 * raw mode passes Ctrl+C on as a byte, so every key arrives as what the program reads.
 */
async function bytesReader(name: string, count: number): Promise<string> {
  const out = test.info().outputPath(`${name}.bin`);
  writeFileSync(out, "");
  await page.keyboard.type(
    `stty raw -echo; echo ${name}-raw-$((2*3)); head -c ${count} > '${out}'; stty sane; echo ${name}-done-$((6*7))`,
  );
  await page.keyboard.press("Enter");
  // Once the tty is raw, a key typed before head reads waits in the tty for it, so the marker is enough.
  await expect(terminal).toContainText(`${name}-raw-6`, { timeout: 15_000 });
  return out;
}

const hex = (path: string): string => readFileSync(path).toString("hex");
const notice = () =>
  page.getByRole("status").filter({ hasText: `Reconnecting to ${machine}. Your typing will be sent.` });

test("keys typed while the machine's line is down are held, said so, and reach it once, in the order typed (#2303)", async () => {
  const out = await bytesReader("held", 10);
  await ask("STOP");
  // Soft, so a page that never says it still types the keys below and shows where they went.
  await expect.soft(notice()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("o");
  await page.keyboard.press("m");
  await page.keyboard.press("o");
  await page.keyboard.insertText("ㅐ");
  await page.keyboard.insertText("한");
  await page.keyboard.press("Control+c");
  await ask("START");

  // o m o ㅐ 한, then Ctrl+C, in the order typed, each exactly once: nothing dropped, nothing twice, nothing reordered.
  await expect.poll(() => hex(out), { timeout: 20_000 }).toBe("6f6d6fe38590ed959c03");
  await expect(terminal).toContainText("held-done-42", { timeout: 15_000 });
  await expect(notice()).toHaveCount(0);
});

test("keys held past the limit are dropped and said to be not sent, and later keys go through", async () => {
  const out = await bytesReader("late", 1);
  await ask("STOP");
  await expect(notice()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("x");
  await expect(page.getByText(`Typed input was not sent because ${machine} did not reconnect within 10 s`)).toBeVisible(
    { timeout: 20_000 },
  );
  await ask("START");
  await expect(notice()).toHaveCount(0, { timeout: 15_000 });

  // The stale x never arrives: the first byte the reader gets is the y typed after the machine came back.
  await page.keyboard.press("y");
  await expect.poll(() => hex(out), { timeout: 20_000 }).toBe("79");
  await expect(terminal).toContainText("late-done-42", { timeout: 15_000 });
});
