import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { DorifaceBridge } from "../src/shared/bridge.ts";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions } from "./launch.ts";

declare global {
  interface Window {
    readonly doriface?: DorifaceBridge;
  }
}

/** Playwright wants a string-only environment. */
const launchEnv = (session: ReturnType<typeof scratchHcSession>): Record<string, string> =>
  Object.fromEntries(
    Object.entries({ ...process.env, ...session.env }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
let hc: ReturnType<typeof scratchHcSession> | undefined;
let launched: ElectronApplication | undefined;

test.beforeAll(async () => {
  // Made here, not at import, so --list and other specs' runs leave no scratch session behind.
  const session = scratchHcSession();
  hc = session;
  launched = await electron.launch(await launchOptions([], { env: launchEnv(session) }));
});

test.afterAll(async () => {
  try {
    await launched?.close();
  } finally {
    await hc?.dispose();
  }
});

const running = (): ElectronApplication => {
  if (launched === undefined) throw new Error("the app did not launch");
  return launched;
};

test("the window opens locked down and reaches a local host", async () => {
  const app = running();
  const page: Page = await app.firstWindow();
  // Reload with the listener attached so violations from the very first paint are seen too.
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text());
  });
  await page.reload();
  await page.waitForSelector("#root > *");
  expect(page.url()).toMatch(/^app:\/\/doriface\//);

  // getLastWebPreferences is bound on every WebContents but missing from electron.d.ts.
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    const read: unknown = contents === undefined ? undefined : Reflect.get(contents, "getLastWebPreferences");
    return typeof read === "function" ? Reflect.apply(read, contents, []) : null;
  });
  console.log(`webPreferences ${JSON.stringify(prefs, null, 2)}`);
  expect(prefs).toMatchObject({
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    webviewTag: false,
  });

  const posture = await page.evaluate(async () => ({
    csp: (await fetch(location.href)).headers.get("content-security-policy"),
    node: "process" in globalThis || "require" in globalThis,
    popup: window.open("https://example.com/") === null,
    platform: window.doriface?.platform,
  }));
  console.log(`renderer posture ${JSON.stringify(posture, null, 2)}`);
  expect(posture.csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
  expect(posture).toMatchObject({ node: false, popup: true, platform: process.platform });

  const local = await page.evaluate(async () => {
    const bridge = window.doriface;
    if (bridge === undefined) throw new Error("no window.doriface");
    const answer = await bridge.startLocalHost();
    if ("failure" in answer) throw new Error(answer.failure.details);
    const endpoint = answer;
    const protocol = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(endpoint.url, ["doriface.v1", `doriface.token.${endpoint.token}`]);
      socket.addEventListener("open", () => {
        resolve(socket.protocol);
        socket.close();
      });
      socket.addEventListener("error", () => reject(new Error(`could not open ${endpoint.url}`)));
    });
    return { url: endpoint.url, protocol };
  });
  console.log(`local host ${JSON.stringify(local)}`);
  expect(local.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/v1\/hc$/);
  expect(local.protocol).toBe("doriface.v1");

  expect(violations).toEqual([]);

  const screenshot = test.info().outputPath("launch.png");
  await page.screenshot({ path: screenshot });
  console.log(`screenshot ${screenshot}`);
});
