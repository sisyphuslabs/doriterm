import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { base64urlEncode, buildPairingUrl, hostIdOf } from "@doriface/crypto";
import electronBinary from "electron";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { appArgs, launchOptions, packagedExecutable } from "./launch.ts";

const signPub = new Uint8Array(32).map((_, index) => (index * 37 + 11) % 256);
const linkSecret = new Uint8Array(32).fill(7);
const SECRET = base64urlEncode(linkSecret);
const PAIR_URL = buildPairingUrl({
  webOrigin: "https://app.doriterm.com",
  hostId: hostIdOf(signPub),
  noiseStaticPub: new Uint8Array(32).map((_, index) => (index * 53 + 7) % 256),
  signPub,
  linkSecret,
  relayUrl: "wss://relay.invalid",
});
const FRAGMENT = PAIR_URL.slice(PAIR_URL.indexOf("#"));

interface Scratch {
  readonly hc: ReturnType<typeof scratchHcSession>;
  readonly profile: string;
  readonly env: Record<string, string>;
}
let scratch: Scratch | undefined;
let launched: ElectronApplication | undefined;

test.beforeAll(async () => {
  const hc = scratchHcSession();
  const profile = mkdtempSync(join(tmpdir(), "dd-pairing-"));
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...hc.env }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  scratch = { hc, profile, env };
  launched = await electron.launch(await launchOptions([profileArg(profile)], { env }));
});

test.afterAll(async () => {
  try {
    await launched?.close();
  } finally {
    if (scratch !== undefined) {
      await scratch.hc.dispose();
      rmSync(scratch.profile, { recursive: true, force: true });
    }
  }
});

const profileArg = (profile: string): string => `--user-data-dir=${profile}`;

/** A checkout launch loads the hide hook, so neither instance ever puts a window on screen. */
function instanceArgs(profile: string): string[] {
  return appArgs([profileArg(profile)]);
}

const running = (): ElectronApplication => {
  if (launched === undefined) throw new Error("the app did not launch");
  return launched;
};

const historyWithSecret = (): Promise<string[]> =>
  running().evaluate(({ BrowserWindow }, secret) => {
    const entries = BrowserWindow.getAllWindows()[0]?.webContents.navigationHistory.getAllEntries() ?? [];
    return entries.map((entry) => entry.url).filter((url) => url.includes(secret));
  }, SECRET);

/** `URL.origin` is "null" for the app: scheme, so the origin is rebuilt from its parts. */
const originOf = (page: Page): string => {
  const url = new URL(page.url());
  return `${url.protocol}//${url.host}`;
};

async function appPage(): Promise<Page> {
  const page = await running().firstWindow();
  await page.waitForSelector("#root > *");
  return page;
}

test("a pairing link's secret leaves the location and the history of the desktop window", async () => {
  const page = await appPage();
  await page.goto(`${originOf(page)}/pair${FRAGMENT}`);
  await expect(page.getByRole("button", { name: "They match" })).toBeVisible();
  expect(page.url()).not.toContain(SECRET);
  expect(await historyWithSecret()).toEqual([]);
});

const windowCount = (): Promise<number> =>
  running().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

/** Back on the workspace, then `send` hands the app a link; it must land on the pairing step in the one window. */
async function expectPairedInApp(page: Page, send: () => Promise<void>): Promise<void> {
  await page.goto(`${originOf(page)}/`);
  await page.waitForSelector("#root > *");
  await send();
  await expect(page).toHaveURL(`${originOf(page)}/pair`);
  await expect(page.getByRole("button", { name: "They match" })).toBeVisible();
  expect(page.url()).not.toContain(SECRET);
  expect(await historyWithSecret()).toEqual([]);
  expect(await windowCount()).toBe(1);
}

test("a doriface://pair link from a second launch pairs in the one window", async () => {
  const page = await appPage();
  await expectPairedInApp(page, async () => {
    if (scratch === undefined) throw new Error("no scratch profile");
    const second = spawn(
      packagedExecutable ?? String(electronBinary),
      [...instanceArgs(scratch.profile), `doriface://pair${FRAGMENT}`],
      { env: scratch.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    second.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    second.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => second.once("exit", resolve));
    expect(code, output).toBe(0);
  });
});

test("a doriface://pair link from open-url (macOS) pairs in the one window", async () => {
  const page = await appPage();
  await expectPairedInApp(page, async () => {
    await running().evaluate(({ app }, url) => {
      app.emit("open-url", { preventDefault: () => undefined }, url);
    }, `doriface://pair${FRAGMENT}`);
  });
});

test("a pairing link opened as a new window (modifier-click, target=_blank, window.open) pairs in the one window", async () => {
  const page = await appPage();
  const placeLink = (target: string): Promise<void> =>
    page.evaluate(
      ({ href, opensIn }) => {
        const anchor = document.createElement("a");
        anchor.id = "pairing-link";
        anchor.href = href;
        anchor.target = opensIn;
        anchor.textContent = "pair";
        anchor.style.cssText = "position:fixed;top:40px;left:40px;z-index:2147483647;padding:8px";
        document.body.append(anchor);
      },
      { href: PAIR_URL, opensIn: target },
    );
  const newWindowModifier = process.platform === "darwin" ? "Meta" : "Control";
  await expectPairedInApp(page, async () => {
    await placeLink("");
    await page.locator("#pairing-link").click({ modifiers: [newWindowModifier] });
  });
  await expectPairedInApp(page, async () => {
    await placeLink("_blank");
    await page.locator("#pairing-link").click();
  });
  await expectPairedInApp(page, () => page.evaluate((url) => void window.open(url, "_blank"), PAIR_URL));
});

test("a pairing link clicked in the app pairs in the app; other links still go to the browser", async () => {
  const page = await appPage();
  await running().evaluate(({ shell }) => {
    const opened: string[] = [];
    Reflect.set(globalThis, "openedExternally", opened);
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  const click = async (href: string): Promise<void> => {
    await page.evaluate((target) => {
      const anchor = document.createElement("a");
      anchor.href = target;
      anchor.textContent = "link";
      document.body.append(anchor);
      anchor.click();
    }, href);
  };
  await expectPairedInApp(page, () => click(PAIR_URL));
  await click("https://github.com/sisyphuslabs/doriterm");
  await expect
    .poll(() => running().evaluate(() => Reflect.get(globalThis, "openedExternally")))
    .toEqual(["https://github.com/sisyphuslabs/doriterm"]);
});
