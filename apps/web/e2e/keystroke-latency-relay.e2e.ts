// Keystroke-to-glyph latency over the real relay code, at phone and desktop width: how long a typed key takes to show
// (to-glyph: the grid or the prediction layer shows it) and how long the host's echo takes (to-echo: the grid shows it),
// over an injected round trip of 0, 150 and 300 ms (the measured relay RTTs are 83-181 ms p50, docs/architecture.md
// §5), with predictions off ("never") and on ("adaptive"). Each test writes two JSON files (Korean and ASCII) under
// test-results/keystroke-latency/ and logs one markdown table row per file.
//
// The relay runs under wrangler dev, so this spec runs only in the Relay e2e CI job or inside this container, never
// directly on a fleet host:
// docker run --rm -v "$PWD":/repo -w /repo -e RELAY_REPO -e DORIFACE_RELAY_READ_TOKEN -e CI=1 mcr.microsoft.com/playwright:v1.64.1-noble bash -lc 'curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4 && export PATH=$HOME/.bun/bin:$PATH && mkdir -p ~/.local/bin && curl -fsSL https://releases.herdr.dev/core/0.1.20/herdr-core-linux-x86_64.tar.gz -o hc.tgz && echo "ac6b86890c451a37584620aaa438b71bc0d0bd430a2e7c1d7e095f052c414e74  hc.tgz" | sha256sum --check --strict && tar -xzf hc.tgz -C ~/.local/bin herdr-core && ln -sf herdr-core ~/.local/bin/hc && export PATH=~/.local/bin:$PATH && bun install --frozen-lockfile && git config --global credential.https://github.com.helper "!f() { test \"$1\" = get && printf \"username=x-access-token\\npassword=%s\\n\" \"$DORIFACE_RELAY_READ_TOKEN\"; }; f" && bun run relay:fetch && cd apps/web && bunx playwright install chromium && DORIFACE_RELAY_DIR=/repo/.relay bun run test:e2e e2e/keystroke-latency-relay.e2e.ts --workers=1'
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  cursorOf,
  graphemesOf,
  latencies,
  type LatencySample,
  startProbe,
  stopProbe,
  summarize,
  widthOf,
} from "./latency-probe.ts";
import { PHONE } from "./phone-key-bar.ts";
import { PRIVATE_RELAY_SKIP } from "./private-relay.ts";
import { pairAndOpenTerminal, type RelayHost, startRelayHost } from "./relay-terminal.ts";
import { LATENCY_MODES, LATENCY_RTTS, latencyCaseTitle } from "./keystroke-latency-cases.ts";

test.skip(process.env["DORIFACE_RELAY_DIR"] === undefined, PRIVATE_RELAY_SKIP);
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });
// Not serial: each row has its own host, so one failed row must not skip the others.
// A host's start, pairing over the relay, then 102 Korean and 115 ASCII keys at 150 ms each over a 300 ms round trip.
test.setTimeout(300_000);

/** The typing cadence, in ms: a brisk typist, slower than any round trip so each key's latency is its own. */
const CADENCE_MS = 150;
const KOREAN = "안녕하세요 한글 입력 지연 측정";
const ASCII = "echo latency probe line";

let host: RelayHost | undefined;

// A fresh host per row: a host keeps every terminal a row opened, and with them on it a later row's page opens into one of
// those (a phone straight into its view, with no New tab) or reads a terminal that is not the one it just opened.
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

/** The commit measured: the runner's checkout, whatever ref it checked out. */
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

/** Waits until the cursor sits after a `$ ` prompt on its own row. */
async function atPrompt(terminal: Locator): Promise<void> {
  await expect
    .poll(async () => (await cursorOf(terminal)).before, { timeout: 30_000, message: "the shell shows its prompt" })
    .toBe("$ ");
}

/** Types `text` and waits until the grid's cursor has moved past its echo. */
async function typeAndWaitForEcho(page: Page, terminal: Locator, text: string): Promise<void> {
  const from = (await cursorOf(terminal)).col;
  await page.keyboard.type(text);
  await expect.poll(async () => (await cursorOf(terminal)).col, { timeout: 30_000 }).toBe(from + widthOf(text));
}

/**
 * Types `line` `repetitions` times, each on a fresh prompt after an `e` whose echo confirms the epoch (a prediction is
 * never drawn for an epoch's first key, D3), and returns one sample per typed grapheme.
 */
async function measure(
  page: Page,
  terminal: Locator,
  line: string,
  repetitions: number,
  source: "keydown" | "insertText",
): Promise<LatencySample[]> {
  const graphemes = graphemesOf(line);
  const cdp = source === "insertText" ? await page.context().newCDPSession(page) : undefined;
  /** One repetition, each typed after the last one's line is answered: they share one prompt. */
  const once = async (): Promise<LatencySample[]> => {
    await typeAndWaitForEcho(page, terminal, "e");
    const start = await cursorOf(terminal);
    await startProbe(terminal, start, source);
    if (cdp === undefined) {
      await page.keyboard.type(line, { delay: CADENCE_MS });
    } else {
      // The cadence is the workload being measured, not a wait for state: one syllable every CADENCE_MS, as committed
      // by an IME, each sent at its own instant from the first.
      const first = Date.now();
      await graphemes.reduce<Promise<void>>(async (previous, grapheme, index) => {
        await previous;
        const due = first + index * CADENCE_MS;
        if (due > Date.now()) await new Promise((resolve) => setTimeout(resolve, due - Date.now()));
        await cdp.send("Input.insertText", { text: grapheme });
      }, Promise.resolve());
    }
    await expect
      .poll(async () => (await cursorOf(terminal)).col, { timeout: 30_000, message: "the host echoed the whole line" })
      .toBe(start.col + widthOf(line));
    const samples = latencies(await stopProbe(terminal), graphemes);
    await page.keyboard.press("Enter");
    await atPrompt(terminal);
    return samples;
  };
  const samples = await Array.from({ length: repetitions }).reduce<Promise<LatencySample[]>>(
    async (previous) => [...(await previous), ...(await once())],
    Promise.resolve([]),
  );
  await cdp?.detach();
  return samples;
}

const ms = (value: number): string => value.toFixed(1);

for (const device of ["desktop", "phone"] as const) {
  test.describe(device, () => {
    test.use(device === "phone" ? PHONE : {});

    for (const rtt of LATENCY_RTTS) {
      for (const mode of LATENCY_MODES) {
        test(latencyCaseTitle(rtt, mode), async ({ page }) => {
          // The prediction preference's own key (apps/web/src/terminal/prediction-mode.ts); a build without the predictor
          // draws no predictions in either mode.
          await page.addInitScript((chosen) => {
            localStorage.setItem("doriface.terminal.predict-typing", chosen);
          }, mode);
          const terminal = await pairAndOpenTerminal(page, relayHost(), { phone: device === "phone", rttMs: rtt });
          // A short fixed prompt, so both lines fit one row at phone width whatever the runner's shell prompt is.
          await terminal.getByRole("textbox").focus();
          await page.keyboard.type("PS1='$ '; echo wa''rm");
          await page.keyboard.press("Enter");
          // `warm` is only ever the command's output (its line reads `wa''rm`): until it shows, the cursor may still sit
          // after the shell's first `$ ` with the typed line's echo a round trip away, and a later read lands mid-echo.
          await expect(terminal).toContainText("warm", { timeout: 30_000 });
          await atPrompt(terminal);

          const out = join(test.info().project.outputDir, "keystroke-latency");
          mkdirSync(out, { recursive: true });
          const lines = [
            ["ko", await measure(page, terminal, KOREAN, 6, "insertText")],
            ["en", await measure(page, terminal, ASCII, 5, "keydown")],
          ] as const;
          for (const [lang, samples] of lines) {
            const { n, median, p95 } = summarize(samples);
            writeFileSync(
              join(out, `${device}-rtt${rtt}-${mode}-${lang}.json`),
              `${JSON.stringify({ samples, median, p95, n, head: HEAD, device, rtt, mode }, null, 2)}\n`,
            );
            console.log(
              `| ${device} | ${rtt} | ${mode} | ${lang} | ${n} | ${ms(median.toGlyphMs)} | ${ms(p95.toGlyphMs)} | ${ms(median.toEchoMs)} | ${ms(p95.toEchoMs)} |`,
            );
            expect(n).toBeGreaterThanOrEqual(100);
          }
        });
      }
    }
  });
}
