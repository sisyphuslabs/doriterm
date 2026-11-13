import type { Page } from "@playwright/test";
import { fitAgents } from "./capture-fit-agents.ts";
import { BAD_LINK, fakeRelay, MESH_LINK, PAIR_CODE, PAIR_LINK } from "./capture-relay.ts";
import { expect } from "./fixtures.ts";
import { agentRow, endAgent, startAgent, startShell } from "./agents.ts";
import { SPACE_CLOSE_SHOTS } from "./capture-space-close-shots.ts";
import { SPACE_RENAME_SHOTS } from "./capture-space-rename-shots.ts";
import { VOICE_SHOTS } from "./capture-voice-shots.ts";
import { seedSpaces } from "./layout-doc.ts";
import { MACHINE_NAME } from "./machine.ts";
import {
  hcOn,
  machineRow,
  reconnect,
  STATE_BOUND_MS,
  switchTo,
  OFFLINE_BOUND_MS,
  OFFLINE_TEST_TIMEOUT_MS,
} from "./machine-switch.ts";
import { resetMeshDocs } from "./mesh-reset.ts";

export type Width = "1440" | "390";
/** Which stored connection a shot starts from: the e2e host, pairing against the fake relay, or none. */
export type Start = "connected" | "pairing" | "none";

export interface Shot {
  readonly name: string;
  readonly start: Start;
  /** Only at this width: the phone views exist below `md` only. */
  readonly only?: Width;
  readonly storageFails?: true;
  /** The shot shows a drag in progress: the pointer stays where `run` left it, still pressed. */
  readonly holdsPointer?: true;
  /** Longer than the default test timeout: the shot waits out a machine's offline grace (#904). */
  readonly timeoutMs?: number;
  readonly run: (page: Page, width: Width) => Promise<void>;
  /** Ends what `run` started, once the shot is taken. */
  readonly cleanup?: () => void;
}

const focusedTerminal = (page: Page) => page.locator('[data-focused="true"] [data-terminal]');
const strip = (page: Page) => page.getByRole("tablist", { name: "Tabs" });

/** The address of a terminal the e2e host seeded, by its name, so a shot writes the layout it captures. */
const addressOf = (name: string): string => {
  const listed: unknown = JSON.parse(hcOn("host", ["ls", "--json"]));
  const terminals = typeof listed === "object" && listed !== null ? Reflect.get(listed, "terminals") : undefined;
  if (!Array.isArray(terminals)) throw new Error("hc ls printed no terminal list");
  const found = terminals.find(
    (terminal: unknown) => typeof terminal === "object" && terminal !== null && Reflect.get(terminal, "name") === name,
  );
  const address = typeof found === "object" && found !== null ? Reflect.get(found, "address") : undefined;
  if (typeof address !== "string") throw new Error(`no terminal named ${name}`);
  return address;
};
/** Opens the seeded terminal whose sidebar row matches, so the shot never depends on which tab opened first. */
const openTerminal = async (page: Page, name: RegExp, text: string | RegExp) => {
  await page.getByRole("button", { name }).first().click();
  await expect(focusedTerminal(page)).toContainText(text, { timeout: 15_000 });
};
const section = async (page: Page, label: string) => {
  await page.goto("/settings");
  await page
    .getByRole("tab", { name: label })
    .or(page.getByRole("button", { name: label }))
    .first()
    .click();
  await expect(page.getByRole("heading", { name: label, level: 2 }).first()).toBeVisible();
};
const scrollToEnd = (page: Page) =>
  page.locator("[data-slot=settings-body]").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
const typeCode = async (page: Page) => {
  await page.goto("/pair");
  await page.getByLabel("Invite link or code").fill(PAIR_CODE);
};
const verifyInvite = async (page: Page) => {
  await page.goto(PAIR_LINK);
  await expect(page.getByRole("heading", { name: "Check the host's key" })).toBeVisible();
};
const refusedWith = (closeCode: number) => async (page: Page) => {
  await fakeRelay(page, closeCode);
  await verifyInvite(page);
  await page.getByRole("button", { name: "They match" }).click();
  await expect(page.getByText("Pairing did not finish")).toBeVisible({ timeout: 15_000 });
};
const SETTINGS = ["Appearance", "This device", "Terminal", "Keybindings"] as const;
/** The mesh panel once its document and the added machine it is checked against have both arrived. */
const meshLoaded = async (page: Page) => {
  resetMeshDocs();
  await page.goto("/");
  await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
  await section(page, "Machines");
  await expect(page.locator('[data-mesh-group="pending"] [data-mesh-answer]').first()).toBeVisible({ timeout: 20_000 });
};

/** The terminal the session-ended shot started on the added machine, by its address there. */
let ended = "";
/** The agent the attention shot starts to finish where that screen is not looking, ended once the shot is taken. */
let verify = "";

export const SHOTS: readonly Shot[] = [
  {
    name: "first-run",
    start: "none",
    run: async (page) => {
      await page.goto("/");
      // An unpaired browser lands on the mesh join entry (#1446), on / and on /pair alike.
      await expect(page.getByRole("heading", { name: "Join a mesh" })).toBeVisible();
    },
  },
  {
    name: "pair",
    start: "pairing",
    run: async (page) => {
      await page.goto("/pair");
      await expect(page.getByRole("heading", { name: "Join a mesh" })).toBeVisible();
    },
  },
  { name: "pair-code", start: "pairing", run: typeCode },
  {
    name: "pair-code-verify",
    start: "pairing",
    run: async (page) => {
      await fakeRelay(page, 4410);
      await verifyInvite(page);
    },
  },
  {
    name: "pair-verify",
    start: "pairing",
    run: async (page) => {
      await page.goto(PAIR_LINK);
      await expect(page.getByRole("heading", { name: "Check the host's key" })).toBeVisible();
    },
  },
  {
    name: "pair-link-invalid",
    start: "pairing",
    run: async (page) => {
      await page.goto(BAD_LINK);
      await expect(page.getByText("This pairing link cannot be used")).toBeVisible();
    },
  },
  {
    name: "pair-mismatch",
    start: "pairing",
    run: async (page) => {
      await page.goto(PAIR_LINK);
      await page.getByRole("button", { name: "They don't match" }).click();
      await expect(page.getByText("Do not pair with this host")).toBeVisible();
    },
  },
  {
    name: "pair-code-mismatch",
    start: "pairing",
    run: async (page) => {
      await fakeRelay(page, 4410);
      await verifyInvite(page);
      await page.getByRole("button", { name: "They don't match" }).click();
      await expect(page.getByText("Do not pair with this host")).toBeVisible();
    },
  },
  { name: "pair-refused-4410", start: "pairing", run: refusedWith(4410) },
  {
    name: "mesh-invite",
    start: "pairing",
    run: async (page) => {
      await page.goto(MESH_LINK);
      await expect(page.getByRole("heading", { name: "Join this mesh" })).toBeVisible();
    },
  },
  { name: "pair-refused-4429", start: "pairing", run: refusedWith(4429) },
  {
    name: "workspace",
    start: "connected",
    run: async (page, width) => {
      await page.goto("/");
      if (width === "390") return void (await expect(page.getByText("Needs you")).toBeVisible());
      await openTerminal(page, /shell/, "$");
      await openTerminal(page, /deploy/, "Waiting for approval");
      await page.getByRole("button", { name: "Split right" }).click();
      // Hidden tabs stay mounted, so only the two shown panes count.
      await expect(page.locator("[data-terminal]:visible")).toHaveCount(2);
      const shown = page.locator("section[data-split='true']:visible");
      await expect(shown.and(page.getByLabel("deploy terminal"))).toHaveCount(1);
      // Split right starts a new shell beside the tab in view, as herdr-app's new_split does.
      await expect(shown.and(page.getByLabel("sh terminal"))).toHaveCount(1);
      await expect(
        page.locator("[data-terminal]:visible").filter({ has: page.locator(".term-row", { hasText: /\S/ }) }),
      ).toHaveCount(2);
      await fitAgents(page);
    },
  },
  {
    name: "pane-drop",
    start: "connected",
    only: "1440",
    holdsPointer: true,
    run: async (page) => {
      await page.goto("/");
      await openTerminal(page, /shell/, "$");
      await openTerminal(page, /deploy/, "Waiting for approval");
      await page.getByRole("button", { name: "Split right" }).click();
      await expect(page.locator("[data-terminal]:visible")).toHaveCount(2);
      // The deploy pane's header held and carried onto the shell pane's right edge: the half it would take shows.
      const title = await page.getByLabel("deploy terminal").locator("header h2").boundingBox();
      const target = await page
        .locator("section[data-split='true']:visible:not([aria-label='deploy terminal'])")
        .boundingBox();
      if (title === null || target === null) throw new Error("no header or target pane to drag");
      await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
      await page.mouse.down();
      await page.mouse.move(target.x + target.width * 0.92, target.y + target.height / 2, { steps: 12 });
      await expect(page.locator("[data-pane-drop='right']")).toBeVisible();
    },
  },
  {
    name: "terminal",
    start: "connected",
    run: async (page, width) => {
      await page.goto("/");
      if (width === "1440") return openTerminal(page, /shell/, "$");
      await page
        .getByRole("button", { name: /deploy/ })
        .first()
        .click();
      await expect(page.locator("[data-terminal]")).toContainText("Waiting for approval", { timeout: 15_000 });
    },
  },
  {
    name: "palette",
    start: "connected",
    run: async (page) => {
      await page.goto("/");
      await expect(page.getByText("Needs you").first()).toBeVisible({ timeout: 15_000 });
      await page.getByRole("button", { name: "Command palette" }).first().click();
      await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
    },
  },
  {
    name: "settings",
    start: "connected",
    run: async (page) => {
      await page.goto("/settings");
      await expect(page.getByRole("heading", { name: "This device", level: 2 }).first()).toBeVisible();
    },
  },
  ...SETTINGS.map((label): Shot => ({
    name: `settings-${label.toLowerCase()}`,
    start: "connected",
    run: (page) => section(page, label),
  })),
  ...SETTINGS.map((label): Shot => ({
    name: `settings-${label.toLowerCase()}-end`,
    start: "connected",
    run: async (page) => {
      await section(page, label);
      await scrollToEnd(page);
    },
  })),
  {
    // The space keys (#619): the number chords and the cycle pair.
    name: "settings-keybindings-spaces",
    start: "connected",
    run: async (page) => {
      await section(page, "Keybindings");
      await page.getByLabel("Search keybindings").fill("space");
      await expect(page.getByText("Go to space 1").first()).toBeVisible();
    },
  },
  { name: "settings-mesh", start: "connected", run: meshLoaded },
  {
    // The fail-closed removal and its re-found command, which neither the top nor the end frame shows at 390.
    name: "settings-mesh-removed",
    start: "connected",
    run: async (page) => {
      await meshLoaded(page);
      await page.locator('[data-mesh-group^="removed-"]').first().scrollIntoViewIfNeeded();
    },
  },
  {
    name: "settings-mesh-end",
    start: "connected",
    run: async (page) => {
      await meshLoaded(page);
      await scrollToEnd(page);
    },
  },
  {
    name: "storage-error",
    start: "connected",
    storageFails: true,
    run: async (page) => {
      await section(page, "Terminal");
      await expect(page.getByRole("alert").first()).toBeVisible();
    },
  },
  {
    name: "storage-error-keybindings",
    start: "connected",
    storageFails: true,
    run: async (page) => {
      await section(page, "Keybindings");
      await expect(page.getByRole("alert").first()).toBeVisible();
    },
  },
  ...VOICE_SHOTS,
  ...SPACE_RENAME_SHOTS,
  ...SPACE_CLOSE_SHOTS,
  {
    // herdr-app's attention on one screen: an agent that finished while its tab was not the one on screen keeps herdr's
    // dot and its Done row, and the agent this screen opened reads Idle here (#611).
    name: "agents-attention",
    start: "connected",
    run: async (page, width) => {
      verify = startAgent("host", "verify", "done", "website");
      seedSpaces([
        {
          folder: "",
          id: "spc-attention",
          name: "website",
          tabs: [
            { id: "tb-att-deploy", name: "deploy", terminal: addressOf("deploy") },
            { id: "tb-att-tests", name: "tests", terminal: addressOf("tests") },
            { id: "tb-att-verify", name: "verify", terminal: verify },
          ],
        },
      ]);
      await page.goto("/");
      if (width === "390") {
        await agentRow(page, "tests", false).click();
        await expect(page.getByRole("button", { name: "Back to agents" })).toBeVisible({ timeout: 15_000 });
        await page.getByRole("button", { name: "Back to agents" }).click();
        await expect(agentRow(page, "verify", false)).toBeVisible({ timeout: 15_000 });
        return;
      }
      // This screen shows the finished agent, then moves to the blocked one: the dot it looked at is gone, the one it
      // did not look at stays.
      await openTerminal(page, /tests/, "128 pass");
      await strip(page).getByRole("tab").filter({ hasText: "deploy" }).click();
      await expect(strip(page).getByRole("tab")).toHaveCount(3);
      await expect(
        strip(page).getByRole("tab").filter({ hasText: "verify" }).getByRole("img", { name: "Done" }),
      ).toBeVisible();
      await expect(strip(page).getByRole("tab").filter({ hasText: "tests" }).getByRole("img")).toHaveCount(0);
    },
    cleanup: () => {
      endAgent("host", verify);
      verify = "";
    },
  },
  {
    // A session whose program ended while its machine was offline, so its view first attaches to a finished terminal.
    name: "session-ended",
    start: "connected",
    timeoutMs: OFFLINE_TEST_TIMEOUT_MS,
    run: async (page, width) => {
      ended = startShell("machine", "nightly-build");
      await page.goto("/");
      await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
      await agentRow(page, "nightly-build", true).click();
      const terminal = page.locator(`[data-terminal="${MACHINE_NAME}/${ended}"]`);
      await expect(terminal).toContainText("$", { timeout: 15_000 });
      switchTo("drop");
      // #2003 (DORITERM-11): the view stays mounted and the status line says the machine is offline.
      await expect(
        (width === "1440" ? page.getByRole("contentinfo") : page)
          .getByRole("status")
          .filter({ hasText: `${MACHINE_NAME} is offline` }),
      ).toBeVisible({
        timeout: OFFLINE_BOUND_MS,
      });
      await expect(terminal).toHaveCount(1);
      hcOn("machine", ["kill", ended]);
      reconnect();
      // The phone's terminal screen has no machine list to wait on.
      if (width === "1440") await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
      await expect(page.getByRole("heading", { name: "This session ended" })).toBeVisible({ timeout: STATE_BOUND_MS });
    },
    cleanup: () => {
      reconnect();
      hcOn("machine", ["rm", ended]);
    },
  },
];
