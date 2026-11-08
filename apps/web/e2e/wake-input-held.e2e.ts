import type { Locator, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { endAgent } from "./agents.ts";
import { E2E_HOST_ENV } from "./config.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { openPhoneTerminal, PHONE } from "./phone-key-bar.ts";
import { readSavedEnv } from "./saved-env.ts";

test.use({ serviceWorkers: "block" });

const opened: string[] = [];
test.afterEach(() => {
  for (const address of opened.splice(0)) endAgent("host", address);
});

/** What the terminal's screen holds on the core itself, so nothing on the page can stand in for it. */
function screenOnCore(address: string): string[] {
  const { hc, env } = readSavedEnv(E2E_HOST_ENV);
  return execFileSync(hc, ["read", address], { env: { ...process.env, ...env }, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
}

/** Every frame across the page's hc sockets, sent ("out") and delivered ("in"), in the order the route saw them. */
type Wire = { readonly link: HcSocket; readonly log: (readonly ["out" | "in", string])[] };

async function wire(page: Page): Promise<Wire> {
  const log: (readonly ["out" | "in", string])[] = [];
  const link = await routeHcSocket(page, {
    sent: (frame) => log.push(["out", frame]),
    received: (frame) => log.push(["in", frame]),
  });
  return { link, log };
}

/** A stream DATA frame (kind 0 on a channel other than RPC's) carrying exactly `text`: one typed key. */
const typed = (frame: string, text: string): boolean =>
  frame.length > 9 && frame.charCodeAt(4) === 0 && frame.slice(0, 4) !== "\0\0\0\0" && frame.slice(9) === text;

/** An RPC frame: channel 0, whose payload is the call's JSON. */
const rpc = (frame: string): boolean => frame.startsWith("\0\0\0\0");

/**
 * Where in the log the wake's check went out after `from`, and where the core's answer to that call came back after it
 * (-1 while it has not): the answer is the RPC reply carrying the check's own id.
 */
function wakeCheck(log: Wire["log"], from: number): { readonly asked: number; readonly answered: number } | undefined {
  const asked = log.findIndex(
    ([way, frame], at) => at >= from && way === "out" && rpc(frame) && frame.includes('"method":"terminal.list"'),
  );
  const id = /"id":(\d+)/.exec(log[asked]?.[1] ?? "")?.[1];
  if (asked === -1 || id === undefined) return undefined;
  const reply = new RegExp(`"id":${id}[,}]`);
  const answered = log.findIndex(
    ([way, frame], at) => at > asked && way === "in" && rpc(frame) && reply.test(frame) && !frame.includes('"method"'),
  );
  return { asked, answered };
}

/** Tells the page it has just become visible, the way a phone returning to the app does. */
const wakeUp = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });

const KEYS = ["a", "b", "c"] as const;

for (const device of ["desktop", "phone"] as const) {
  test.describe(device, () => {
    if (device === "phone") test.use({ ...PHONE });

    async function terminalFor(page: Page): Promise<{ readonly terminal: Locator; readonly address: string }> {
      let terminal: Locator;
      if (device === "phone") terminal = await openPhoneTerminal(page);
      else {
        await page.goto("/");
        terminal = await openNewTerminal(page);
      }
      const address = (await terminal.getAttribute("data-terminal")) ?? "";
      opened.push(address);
      return { terminal, address };
    }

    test("keys typed while a wake checks the link wait for its answer, then reach the shell once (#1370)", async ({
      page,
    }) => {
      const { link, log } = await wire(page);
      const { address } = await terminalFor(page);
      link.delay(250);
      const release = link.hold("terminal.list");
      const from = log.length;
      await wakeUp(page);
      await expect.poll(() => wakeCheck(log, from)?.asked).toBeGreaterThanOrEqual(from);
      await page.keyboard.type(KEYS.join(""));
      release();

      await expect.poll(() => screenOnCore(address).join("\n"), { timeout: 15_000 }).toContain("abc");
      const check = wakeCheck(log, from);
      const keys = log.flatMap(([way, frame], at) => (way === "out" && KEYS.some((k) => typed(frame, k)) ? [at] : []));
      expect(keys).toHaveLength(KEYS.length);
      // No key left the page before the link answered the check.
      expect(check?.answered ?? -1).toBeGreaterThan(check?.asked ?? Infinity);
      expect(Math.min(...keys)).toBeGreaterThan(check?.answered ?? Infinity);
      expect(screenOnCore(address).filter((line) => line.includes("abc"))).toHaveLength(1);
      expect(screenOnCore(address).join("\n")).not.toContain("abcabc");
    });

    test("keys typed while an unanswered wake check runs reach the new link once, after the reconnect (#1370)", async ({
      page,
    }) => {
      const { link, log } = await wire(page);
      const { address } = await terminalFor(page);
      const before = link.opened();
      const releaseHost = link.holdFromHost("");
      const from = log.length;
      await wakeUp(page);
      await expect.poll(() => wakeCheck(log, from)?.asked).toBeGreaterThanOrEqual(from);
      await page.keyboard.type(KEYS.join(""));
      // The check is never answered, so its deadline drops the link and the store dials again.
      await expect.poll(link.opened, { timeout: 20_000 }).toBeGreaterThan(before);
      releaseHost();

      await expect.poll(() => screenOnCore(address).join("\n"), { timeout: 20_000 }).toContain("abc");
      const keys = log.filter(([way, frame]) => way === "out" && KEYS.some((k) => typed(frame, k)));
      expect(keys).toHaveLength(KEYS.length);
      expect(screenOnCore(address).filter((line) => line.includes("abc"))).toHaveLength(1);
      expect(screenOnCore(address).join("\n")).not.toContain("abcabc");
    });
  });
}
