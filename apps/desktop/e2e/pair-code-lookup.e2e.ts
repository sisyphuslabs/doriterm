// #535: pairing by typed code looks the code up over the relay's HTTPS origin, which the desktop app's CSP must let through.
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions } from "./launch.ts";

/** A scratch hc session and a scratch profile, made only when the tests run (not on --list). */
interface Scratch {
  readonly hc: ReturnType<typeof scratchHcSession>;
  readonly profile: string;
  readonly shellHome: string;
}
let scratch: Scratch | undefined;
let launched: ElectronApplication | undefined;

test.beforeAll(async () => {
  const hc = scratchHcSession();
  // A scratch profile, so the app always starts on first run with nothing saved.
  const profile = mkdtempSync(join(tmpdir(), "dd-profile-"));
  // A shell that starts clean: bash without profile or rc files (macOS's /etc/bashrc sets a prompt with
  // the host and user) and a scratch HOME, so the screenshot shows nothing of this machine.
  const shellHome = mkdtempSync(join(tmpdir(), "dd-shell-"));
  writeFileSync(join(shellHome, "clean-shell"), "#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n", { mode: 0o755 });
  scratch = { hc, profile, shellHome };
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ...hc.env,
      // A bare name found on PATH, so the terminal title is "clean-shell" rather than a scratch path.
      SHELL: "clean-shell",
      PATH: `${shellHome}:${process.env["PATH"] ?? ""}`,
      HOME: shellHome,
      PS1: "$ ",
      ENV: "",
      BASH_SILENCE_DEPRECATION_WARNING: "1",
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const args = [`--user-data-dir=${profile}`];
  launched = await electron.launch(await launchOptions(args, { env }));
});

test.afterAll(async () => {
  try {
    await launched?.close();
  } finally {
    if (scratch !== undefined) {
      await scratch.hc.dispose();
      rmSync(scratch.profile, { recursive: true, force: true });
      rmSync(scratch.shellHome, { recursive: true, force: true });
    }
  }
});

/** The relay's code lookup, answered here: no host holds the code. */
const LOOKUP = "https://relay-doriface.omo.dev/v1/pair/*";

test("a typed pairing code is looked up through the relay, not refused by the app before it leaves", async () => {
  if (launched === undefined) throw new Error("the app did not launch");
  const page = await launched.firstWindow();
  const lookups: string[] = [];
  // The relay's answer is held until Continue is pressed. Typing the code starts its slot's lookup (#1277), and
  // Continue takes the answer of that lookup, still in flight here, so exactly one request leaves; an answer that
  // arrives first is reused the same way, refusal included (#1316).
  const { promise: pressed, resolve: answer } = Promise.withResolvers<void>();
  await page.route(LOOKUP, async (route) => {
    lookups.push(route.request().url());
    await pressed;
    await route.fulfill({ status: 404, body: "" });
  });
  await page
    .getByRole("link", { name: "Pair a host" })
    .or(page.getByRole("button", { name: "Pair a host" }))
    .first()
    .click();
  // The entry a fresh app shows since the mesh join (#1446, #1552): one field takes an invite link or a typed code.
  await expect(page.getByRole("heading", { name: "Join a mesh", exact: true })).toBeVisible();
  await page.getByLabel("Invite link or code").fill("K7QM 4XPD");
  // Typing alone asks the relay for the code's slot, its first three characters.
  await expect.poll(() => lookups).toEqual(["https://relay-doriface.omo.dev/v1/pair/K7Q"]);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  answer();
  // The relay's own answer reaches the page: the code is unknown, not the relay unreachable.
  await expect(page.getByText("No host is pairing with this code. It may have expired.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("The relay cannot be reached")).toHaveCount(0);
  expect(lookups).toEqual(["https://relay-doriface.omo.dev/v1/pair/K7Q"]);
});
