// Coming back to the app over the real relay code, at phone and desktop width, over a 300 ms round trip: the screen is
// painted as it is now in one frame, and a reconnect's replay is painted once, never climbing (design D5, the relay
// twin of terminal-resume-catchup.e2e.ts).
//
// The relay runs under wrangler dev, so this spec runs only in the Relay e2e CI job or inside this container, never
// directly on a fleet host:
// docker run --rm -v "$PWD":/repo -w /repo -e RELAY_REPO -e DORIFACE_RELAY_READ_TOKEN -e CI=1 mcr.microsoft.com/playwright:v1.64.1-noble bash -lc 'curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4 && export PATH=$HOME/.bun/bin:$PATH && mkdir -p ~/.local/bin && curl -fsSL https://releases.herdr.dev/core/0.1.17/herdr-core-linux-x86_64.tar.gz -o hc.tgz && echo "82ec44043f6894bfdb716b979b87cda43fd7fa46b0104e7b7bd93e64d1a9b877  hc.tgz" | sha256sum --check --strict && tar -xzf hc.tgz -C ~/.local/bin herdr-core && ln -sf herdr-core ~/.local/bin/hc && export PATH=~/.local/bin:$PATH && bun install --frozen-lockfile && git config --global credential.https://github.com.helper "!f() { test \"$1\" = get && printf \"username=x-access-token\\npassword=%s\\n\" \"$DORIFACE_RELAY_READ_TOKEN\"; }; f" && bun run relay:fetch && cd apps/web && bunx playwright install chromium && DORIFACE_RELAY_DIR=/repo/.relay bun run test:e2e e2e/terminal-resume-relay.e2e.ts --workers=1'
import { existsSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { PHONE } from "./phone-key-bar.ts";
import { PRIVATE_RELAY_SKIP } from "./private-relay.ts";
import { pairAndOpenTerminal, RelayLink, type RelayHost, startRelayHost } from "./relay-terminal.ts";
import {
  hiddenDocumentFrames,
  hide,
  pageMessages,
  sampledFrames,
  startLastLineSampler,
  transitions,
} from "./resume-probe.ts";

test.skip(process.env["DORIFACE_RELAY_DIR"] === undefined, PRIVATE_RELAY_SKIP);
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });
// Pairing over the relay, then a flood and a reconnect over a 300 ms round trip.
test.setTimeout(240_000);

/** The measured relay round trips are 83-181 ms p50 (docs/architecture.md §5); a slow one, so pacing shows. */
const RTT_MS = 300;
const LAST = 4000;
/** Far more output than one frame's 16 KiB, so a paced write shows up as frames that climb. */
const flood = (done: string): string => `for i in $(seq 1 ${LAST}); do echo relay-line-$i; done; : > '${done}'`;
/** The page's relay client sockets, as delayRelaySockets routes them. */
const CLIENT_SOCKET = "/v1/client/";

let host: RelayHost | undefined;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  host = await startRelayHost();
});

test.afterAll(async () => {
  await host?.stop();
});

const relayHost = (): RelayHost => {
  if (host === undefined) throw new Error("no relayed host");
  return host;
};

/** Resolves once the page has handled every frame the relay has sent toward it so far. */
async function delivered(page: Page, link: RelayLink): Promise<void> {
  const sent = link.toPage();
  await expect.poll(() => pageMessages(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(sent);
}

for (const device of ["desktop", "phone"] as const) {
  test.describe(device, () => {
    test.use(device === "phone" ? PHONE : {});

    test("over the relay, coming back to the app paints the screen as it is now in its first frame, not a replay (D5)", async ({
      page,
    }) => {
      await hiddenDocumentFrames(page, CLIENT_SOCKET);
      const link = new RelayLink();
      const terminal = await pairAndOpenTerminal(page, relayHost(), { phone: device === "phone", rttMs: RTT_MS, link });
      await terminal.getByRole("textbox").focus();

      // Everything the program prints arrives while the app is in the background: its first byte is a round trip
      // after the Enter, and the shell marks the end once it has printed the last line.
      const done = test.info().outputPath("flood-done");
      await page.keyboard.type(flood(done));
      await page.keyboard.press("Enter");
      await hide(page);
      await expect.poll(() => existsSync(done), { timeout: 60_000 }).toBe(true);
      await delivered(page, link);

      await startLastLineSampler(terminal, "show");
      await expect(terminal).toContainText(`relay-line-${LAST}`, { timeout: 30_000 });
      const frames = await sampledFrames(page);
      expect(frames.length).toBeGreaterThan(0);
      // The first frame after the app shows already holds the last line: no frame climbs toward it.
      expect(frames[0]).toBe(LAST);
      expect(frames.filter((last) => last !== LAST)).toEqual([]);
    });

    test("over the relay, a reconnect's replay is painted once it has settled: the screen never climbs back (D5, #1040)", async ({
      page,
    }) => {
      await page.addInitScript(() => {
        Reflect.set(window, "__dorifaceAttachLog", []);
      });
      const link = new RelayLink();
      const terminal = await pairAndOpenTerminal(page, relayHost(), { phone: device === "phone", rttMs: RTT_MS, link });
      await terminal.getByRole("textbox").focus();
      const done = test.info().outputPath("flood-done");
      await page.keyboard.type(flood(done));
      await page.keyboard.press("Enter");
      await expect(terminal).toContainText(`relay-line-${LAST}`, { timeout: 60_000 });

      await startLastLineSampler(terminal, "nothing");
      const before = link.opened();
      await link.drop();
      await expect.poll(() => link.opened(), { timeout: 60_000 }).toBeGreaterThan(before);
      await expect
        .poll(() => page.evaluate(() => (Reflect.get(window, "__dorifaceAttachLog") as unknown[]).length), {
          timeout: 60_000,
        })
        .toBeGreaterThanOrEqual(2);
      // Output after the replay marks the replay as delivered and painted.
      await page.keyboard.type("echo done-$((1+1))");
      await page.keyboard.press("Enter");
      await expect(terminal).toContainText("done-2", { timeout: 30_000 });
      const frames = await sampledFrames(page);

      expect(frames.length).toBeGreaterThan(0);
      expect(frames.at(-1)).toBe(LAST);
      // The old screen stays until the replay is drawn whole: at most one change, never an empty or climbing screen.
      expect(transitions(frames)).toBeLessThanOrEqual(1);
      expect(frames.filter((last) => last !== LAST)).toEqual([]);
    });
  });
}
