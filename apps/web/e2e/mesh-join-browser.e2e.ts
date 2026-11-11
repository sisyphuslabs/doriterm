import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { RUN_DIR } from "./run-dir.ts";

// #1413's browser join was proved in a bun process only: the web modules ran there, on a memory store and a raw key,
// against the private relay under wrangler dev. This spec runs the same join in a real Chromium at a phone's size, so the
// page's own WebCrypto device key, its own Ed25519 signing key and its own IndexedDB join the mesh and then open a session
// to the member that did NOT invite it. The two hosts come from tests/relay/support/web-mesh-hosts.ts, using the pinned
// private relay when DORIFACE_RELAY_DIR is set and the multi-host FakeRelay otherwise (#1297).
test.use({ serviceWorkers: "block" });
test.setTimeout(300_000);

const HELPER = join(import.meta.dirname, "..", "..", "..", "tests", "relay", "support", "web-mesh-hosts.ts");
/** The page-side entry: src/mesh and what it needs, reachable from a page. Nothing under src/ imports it, so no build ships it. */
const ENTRY = join(import.meta.dirname, "mesh-join-page.ts");
const BUNDLE = join(RUN_DIR, "mesh-join-page.js");
/** The path this spec serves that entry on: the app's build writes no such file, and this page is the only one that asks. */
const HARNESS_URL = "/__mesh-join-page.js";
const PHONE = { width: 390, height: 844 };
const DEVICE_NAME = "Chrome on Android";
const MEMBER_NAME = "chrome-on-android";

let helper: ChildProcess | undefined;
let reader: AsyncIterator<string> | undefined;
let bHostId = "";

/** The entry as the page will run it: built for the browser by bun, so every one of those modules is page code. */
function bundle(): string {
  execFileSync(
    "bun",
    ["build", ENTRY, "--target=browser", "--format=esm", "--outfile", BUNDLE, "--define", "import.meta.env.DEV=false"],
    { stdio: "pipe" },
  );
  return readFileSync(BUNDLE, "utf8");
}

async function nextLine(prefix: string): Promise<string> {
  const next = await reader?.next();
  if (next === undefined || next.done === true) throw new Error(`mesh-hosts ended before a ${prefix.trim()} line`);
  return next.value.startsWith(prefix) ? next.value.slice(prefix.length) : nextLine(prefix);
}

async function ask(line: string, prefix: string): Promise<string> {
  helper?.stdin?.write(`${line}\n`);
  return nextLine(prefix);
}

const at = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

/** The field `key` of the page's answer, refused rather than read when the page did not send it. */
function field(value: unknown, key: string): string {
  const raw = at(value, key);
  if (typeof raw !== "string") throw new Error(`the page answered no ${key}`);
  return raw;
}

function listOf(value: unknown, key: string): readonly unknown[] {
  const raw = at(value, key);
  if (!Array.isArray(raw)) throw new Error(`the page answered no ${key} list`);
  return raw;
}

/** What the page sent back: plain data, read field by field, so a missing field fails instead of reading as undefined. */
type Answer = Readonly<Record<string, unknown>>;

/** The page, at a phone's size, on the app's own origin: the store and the crypto the join uses are the app's. */
async function phone(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: PHONE,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  // Nothing here needs the e2e host, and a page that dials the production relay would spend the test's time on the
  // network: loopback settings point it at a closed port, which fails at once and quietly.
  await context.addInitScript(() =>
    localStorage.setItem(
      "doriface.connection",
      JSON.stringify({ mode: "loopback", loopbackUrl: "ws://127.0.0.1:9/v1/hc", token: "unused" }),
    ),
  );
  const page = await context.newPage();
  await page.goto("/");
  return page;
}

test.beforeAll(async () => {
  const { FORCE_COLOR: _colour, ...inherited } = process.env;
  helper = spawn("bun", [HELPER], { stdio: ["pipe", "pipe", "inherit"], env: { ...inherited, NO_COLOR: "1" } });
  if (helper.stdout === null) throw new Error("mesh-hosts has no stdout");
  reader = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
  ({ bHostId } = JSON.parse(await nextLine("READY ")) as { bHostId: string });
});

test.afterAll(async () => {
  const running = helper;
  if (running === undefined) return;
  running.kill("SIGTERM");
  await expect.poll(() => running.exitCode ?? running.signalCode, { timeout: 90_000 }).not.toBeNull();
});

test("at 390x844 the page's own WebCrypto and IndexedDB join the mesh and reach the other machine over the relay", async ({
  browser,
}) => {
  const page = await phone(browser);
  const entry = bundle();
  await page.route(`**${HARNESS_URL}`, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: entry }),
  );

  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    ratio: window.devicePixelRatio,
  }));
  expect(page.viewportSize()).toEqual(PHONE);
  expect(viewport).toEqual({ ...PHONE, ratio: 3 });

  // The code the page derives goes to the inviting machine, which approves it only if its pending join shows the same.
  await page.exposeFunction(
    "approveJoinCode",
    async (code: string) => (await ask(`APPROVE ${code}`, "APPROVED ")) === "yes",
  );
  const hash = await ask("MESH", "LINK ");

  // Everything below runs inside the page: `join` and `reach` are the modules under src/mesh, on the browser's default
  // deps, so the device key, the signing key and the membership are the page's own.
  const proof: Answer = await page.evaluate(
    async ({ specifier, fragment, deviceName }) => {
      const loaded: unknown = await import(specifier);
      const call = (name: string, ...args: readonly unknown[]): unknown => {
        const fn: unknown = typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, name) : undefined;
        if (typeof fn !== "function") throw new Error(`the join entry exports no ${name}`);
        return Reflect.apply(fn, loaded, [...args]);
      };
      return {
        joined: await call("join", fragment, deviceName),
        again: await Promise.resolve(call("join", fragment, deviceName)).then(
          () => "joined a second time",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
        deviceKey: await call("deviceKeyKind"),
        stored: await call("stored"),
      };
    },
    { specifier: HARNESS_URL, fragment: hash, deviceName: DEVICE_NAME },
  );

  const meshId = field(proof["joined"], "meshId");
  const hostId = field(proof["joined"], "hostId");
  const members = listOf(proof["joined"], "members").map((member) => ({
    name: field(member, "name"),
    hostId: field(member, "hostId"),
    kind: field(member, "kind"),
  }));
  expect(members.map((member) => member.kind).toSorted()).toEqual(["client", "machine", "machine"]);
  expect(members.find((member) => member.hostId === hostId)?.name).toBe(MEMBER_NAME);
  expect(proof["deviceKey"]).toBe("webcrypto");
  expect(field(proof["stored"], "meshId")).toBe(meshId);
  expect(proof["again"]).toBe(`this browser is in mesh ${meshId} already`);

  // The machines' own view of the join: b learned the admission by gossip from a, which is what lets it admit the page.
  const machines: unknown = JSON.parse(await ask("STATUS", "MEMBERS "));
  expect(field(machines, "meshId")).toBe(meshId);
  for (const machine of ["a", "b"]) {
    const held = listOf(machines, machine).map((member) => ({
      name: field(member, "name"),
      hostId: field(member, "hostId"),
    }));
    expect(held).toContainEqual({ name: MEMBER_NAME, hostId });
  }

  const reached: Answer = await page.evaluate(
    async ({ specifier, target }) => {
      const loaded: unknown = await import(specifier);
      const reach: unknown = typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "reach") : undefined;
      if (typeof reach !== "function") throw new Error("the join entry exports no reach");
      return Reflect.apply(reach, loaded, [target]);
    },
    { specifier: HARNESS_URL, target: bHostId },
  );
  expect(field(reached, "path")).toBe("relay");
  expect(at(reached, "framed")).toBe(true);
  expect(listOf(reached, "terminals")).toContain("on-b");

  // The inviter cannot forward this request: its host has stopped. The other member's terminal and the page's own
  // authorization still work through a fresh direct session to that member.
  expect(await ask("STOP_INVITER", "STOPPED ")).toBe("inviter");
  const surviving: Answer = await page.evaluate(
    async ({ specifier, target }) => {
      const loaded: unknown = await import(specifier);
      const reach: unknown = typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "reach") : undefined;
      if (typeof reach !== "function") throw new Error("the join entry exports no reach");
      return Reflect.apply(reach, loaded, [target]);
    },
    { specifier: HARNESS_URL, target: bHostId },
  );
  expect(field(surviving, "hostId")).toBe(bHostId);
  expect(listOf(surviving, "terminals")).toContain("on-b");

  // The membership and the page's keys came back from IndexedDB in a new document, not from anything this run held.
  await page.reload();
  const after: Answer = await page.evaluate(
    async ({ specifier }) => {
      const loaded: unknown = await import(specifier);
      const call = (name: string): unknown => {
        const fn: unknown = typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, name) : undefined;
        if (typeof fn !== "function") throw new Error(`the join entry exports no ${name}`);
        return Reflect.apply(fn, loaded, []);
      };
      return { stored: await call("stored"), deviceKey: await call("deviceKeyKind") };
    },
    { specifier: HARNESS_URL },
  );
  expect(field(after["stored"], "meshId")).toBe(meshId);
  expect(field(after["stored"], "signPub")).toBe(field(proof["joined"], "signPub"));
  expect(after["deviceKey"]).toBe("webcrypto");
});
