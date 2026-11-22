// Coming back to the app over the real relay code, at phone and desktop width, over a 300 ms round trip: the screen is
// painted as it is now in one frame, and a reconnect's replay is painted once, never climbing (design D5, the relay
// twin of terminal-resume-catchup.e2e.ts).
//
// The relay runs under wrangler dev, so this spec runs only in the Relay e2e CI job or inside this container, never
// directly on a fleet host:
// docker run --rm -v "$PWD":/repo -w /repo -e RELAY_REPO -e DORIFACE_RELAY_READ_TOKEN -e CI=1 mcr.microsoft.com/playwright:v1.64.1-noble bash -lc 'curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4 && export PATH=$HOME/.bun/bin:$PATH && mkdir -p ~/.local/bin && curl -fsSL https://releases.herdr.dev/core/0.1.21/herdr-core-linux-x86_64.tar.gz -o hc.tgz && echo "78424755c10a40dde38a0bdb55c20ac19706e9ae05ed68fc2acf1fcff0d941c1  hc.tgz" | sha256sum --check --strict && tar -xzf hc.tgz -C ~/.local/bin herdr-core && ln -sf herdr-core ~/.local/bin/hc && export PATH=~/.local/bin:$PATH && bun install --frozen-lockfile && git config --global credential.https://github.com.helper "!f() { test \"$1\" = get && printf \"username=x-access-token\\npassword=%s\\n\" \"$DORIFACE_RELAY_READ_TOKEN\"; }; f" && bun run relay:fetch && cd apps/web && bunx playwright install chromium && DORIFACE_RELAY_DIR=/repo/.relay bun run test:e2e e2e/terminal-resume-relay.e2e.ts --workers=1'
import { expect, test } from "@playwright/test";
import { PHONE } from "./phone-key-bar.ts";
import { PRIVATE_RELAY_SKIP } from "./private-relay.ts";
import { pairAndOpenTerminal, RelayLink, type RelayHost, startRelayHost } from "./relay-terminal.ts";
import { hiddenDocumentFrames, hide, sampledFrames, startLastLineSampler, transitions } from "./resume-probe.ts";

test.skip(process.env["DORIFACE_RELAY_DIR"] === undefined, PRIVATE_RELAY_SKIP);
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });
// A relay, host and core of its own (up to 180 s to start), pairing over the relay, then a flood and a reconnect over a
// 300 ms round trip.
test.setTimeout(420_000);

/** The measured relay round trips are 83-181 ms p50 (docs/architecture.md §5); a slow one, so pacing shows. */
const RTT_MS = 300;
const LAST = 4000;
/** The window title the shell sets once it has printed the last line. */
const FLOOD_END = "relay-flood-end";
/**
 * Far more output than one frame's 16 KiB, so a paced write shows up as frames that climb. Then the title: the core
 * sends it as an event behind the output on the same stream, and the page shows it without painting the terminal, so
 * the title in the pane's name means every line has reached the page, held or not. A New tab runs the host user's
 * shell, and a stock Debian or Ubuntu bash prompt sets the title too (`\e]0;user@host: cwd\a` in PS1): the prompt that
 * follows the flood would put that title back before the page could be asked for this one (#2016). So the command first
 * sets a prompt that leaves the title alone.
 */
const FLOOD = `PS1='$ '; unset PROMPT_COMMAND; for i in $(seq 1 ${LAST}); do echo relay-line-$i; done; printf '\\033]2;${FLOOD_END}\\007'`;
/** The page's relay client sockets, as delayRelaySockets routes them. */
const CLIENT_SOCKET = "/v1/client/";

let host: RelayHost | undefined;

// Each test has a host of its own: on a shared one the next device finds the last test's terminals, and its New tab
// races them for the pane in view.
test.beforeEach(async () => {
  host = await startRelayHost();
});

test.afterEach(async () => {
  await host?.stop();
  host = undefined;
});

const relayHost = (): RelayHost => {
  if (host === undefined) throw new Error("no relayed host");
  return host;
};

for (const device of ["desktop", "phone"] as const) {
  test.describe(device, () => {
    test.use(device === "phone" ? PHONE : {});

    test("over the relay, coming back to the app paints the screen as it is now in its first frame, not a replay (D5)", async ({
      page,
    }) => {
      await hiddenDocumentFrames(page, CLIENT_SOCKET);
      const terminal = await pairAndOpenTerminal(page, relayHost(), { phone: device === "phone", rttMs: RTT_MS });
      await terminal.getByRole("textbox").focus();

      // Everything the program prints arrives while the app is in the background: its first byte is a round trip
      // after the Enter. A file the shell writes at the end would only say the core has the lines, not the page: the
      // relay may still carry them, and the app shown before they arrive has nothing new to paint.
      await page.keyboard.type(FLOOD);
      await page.keyboard.press("Enter");
      await hide(page);
      await expect(terminal).toHaveAttribute("aria-label", `${FLOOD_END} output`, { timeout: 60_000 });

      await startLastLineSampler(terminal, "show");
      await expect(terminal).toContainText(`relay-line-${LAST}`, { timeout: 30_000 });
      const frames = await sampledFrames(page);
      expect(frames.length).toBeGreaterThan(0);
      // The first frame after the app shows already holds the last line: no frame climbs toward it.
      expect(frames[0]).toBe(LAST);
      expect(frames.filter((last) => last !== LAST)).toEqual([]);
    });

    // Contract v1.11 (#1995): a relay drop no longer re-attaches and replays; the session is carried on over a new socket,
    // so no terminal attaches again and the screen does not change at all (the D5 replay path stays for a session that
    // cannot be carried on, and terminal-resume-catchup.e2e.ts paints it).
    test("over the relay, a reconnect carries the session on: nothing re-attaches and the screen never changes (D5, #1040, #1995)", async ({
      page,
    }) => {
      await page.addInitScript(() => {
        Reflect.set(window, "__dorifaceAttachLog", []);
      });
      const link = new RelayLink();
      const terminal = await pairAndOpenTerminal(page, relayHost(), { phone: device === "phone", rttMs: RTT_MS, link });
      await terminal.getByRole("textbox").focus();
      await page.keyboard.type(FLOOD);
      await page.keyboard.press("Enter");
      await expect(terminal).toContainText(`relay-line-${LAST}`, { timeout: 60_000 });

      const attaches = (): Promise<number> =>
        page.evaluate(() => (Reflect.get(window, "__dorifaceAttachLog") as unknown[]).length);
      const attachedBefore = await attaches();
      expect(attachedBefore).toBeGreaterThanOrEqual(1);
      await startLastLineSampler(terminal, "nothing");
      const before = link.opened();
      await link.drop();
      await expect.poll(() => link.opened(), { timeout: 60_000 }).toBeGreaterThan(before);
      // Typed on the dropped link, it waits for the session to be carried on and then reaches the same shell.
      await page.keyboard.type("echo done-$((1+1))");
      await page.keyboard.press("Enter");
      await expect(terminal).toContainText("done-2", { timeout: 30_000 });
      const frames = await sampledFrames(page);

      expect(await attaches()).toBe(attachedBefore);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.at(-1)).toBe(LAST);
      // Nothing was replayed, so the screen never changed: no empty, climbing or repainted frame.
      expect(transitions(frames)).toBe(0);
      expect(frames.filter((last) => last !== LAST)).toEqual([]);
    });
  });
}
