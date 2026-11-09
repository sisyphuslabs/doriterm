import { expect, test } from "./fixtures.ts";
import { pushButton, pushState, settingsSection } from "./push-suite.ts";

test.use({ serviceWorkers: "block" });

/**
 * Settings > Notifications in the desktop app, with notifications on and the OS refusing them (#1046, #1151). The shell's
 * notice calls are answered by a fake, the only way a browser spec reaches them: the real ones are the desktop shell's
 * IPC. noticeControls() is unit-tested; this proves the section renders what it returns.
 */
test("a refused desktop notification shows Check again and Turn off together and holds the other controls", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Reflect.set(window, "doriface", {
      noticesSupported: async () => true,
      noticePermission: async () => "denied",
      showNotice: async () => ({ accepted: false, reason: "refused by the OS" }),
      onNoticeClick: () => {},
    });
    const events = { input: true, permission: true, done: true, error: true };
    localStorage.setItem("doriface.desktop-notices", JSON.stringify({ on: true, prefs: { events, muted: [] } }));
  });
  await page.goto("/settings");
  await settingsSection(page, "Notifications").click();

  await expect(pushState(page)).toHaveAttribute("data-push-state", "blocked", { timeout: 20_000 });
  await expect(pushButton(page, "Check again")).toBeEnabled();
  await expect(pushButton(page, "Turn off")).toBeEnabled();
  await expect(pushButton(page, "Turn on")).toHaveCount(0);
  await expect(pushButton(page, "Send test")).toBeDisabled();
  const events = pushState(page).locator("[data-push-event]");
  await expect(events).toHaveCount(4);
  await Promise.all((await events.all()).map((event) => expect(event).toBeDisabled()));
  // The machine mutes show once the connection is open; at least this machine's row is listed.
  const machines = pushState(page).locator("[data-push-machine]");
  await expect(machines).not.toHaveCount(0, { timeout: 20_000 });
  await Promise.all((await machines.all()).map((machine) => expect(machine).toBeDisabled()));

  // Turn off reaches turnOff(): off and still refused, Check again is all that is left.
  await pushButton(page, "Turn off").click();
  await expect(pushButton(page, "Turn off")).toHaveCount(0);
  await expect(pushButton(page, "Check again")).toBeEnabled();
  await expect(pushButton(page, "Send test")).toBeDisabled();
});
