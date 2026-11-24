// An agent started from the tab strip's new menu opens as a tab of the selected space, even when hc answers its run
// only once the agent is ready, long after the page's adoption grace (#2747).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_HOST_ENV } from "./config.ts";
import { getCoreDoc } from "./core-doc.ts";
import { type DocSpace, spacesShowing } from "./core-tabs.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { LAYOUT_DOC } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { readSavedEnv } from "./saved-env.ts";
import { tabOf } from "./tab-strip.ts";

endOwnTerminals();

test.use({ serviceWorkers: "block" });

const TEMPLATE = "slow-ready-agent";
/** Longer than the adoption grace (ADOPT_GRACE_MS, 5 s): hc answers a template's run only once the agent is ready. */
const READY_AFTER_S = 8;

const docSpaces = (): readonly DocSpace[] =>
  (getCoreDoc(LAYOUT_DOC) as { spaces?: readonly DocSpace[] } | null)?.spaces ?? [];
const agentAddress = (): string | undefined =>
  (JSON.parse(hcOn("host", ["ls", "--json"])) as { terminals: { address: string; name?: string }[] }).terminals.find(
    (terminal) => terminal.name === TEMPLATE,
  )?.address;

test("an agent from the new menu opens in the selected space, not a new one, when its run answers late", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // The host's core reads its templates from this run's own config dir (e2e/host.ts).
  const config = readSavedEnv(E2E_HOST_ENV).env["XDG_CONFIG_HOME"] ?? "";
  const templates = join(config, "herdr-core", "templates");
  const script = join(config, `${TEMPLATE}.sh`);
  mkdirSync(templates, { recursive: true });
  writeFileSync(script, `sleep ${READY_AFTER_S}\nprintf '\\033]7501;state=idle\\033\\\\'\nexec sleep 600\n`);
  writeFileSync(
    join(templates, `${TEMPLATE}.md`),
    // A body is a first message, which hc sends once the agent is ready, and answers the run only then.
    `---\nname: ${TEMPLATE}\ndescription: ready after ${READY_AFTER_S} s\ncommand: sh ${script}\n---\nWait.\n`,
  );
  try {
    await page.goto("/");
    const shell = await openNewTerminal(page);
    const address = (await shell.getAttribute("data-terminal")) ?? "";
    const selected = docSpaces().find((space) => spacesShowing(address).includes(space.name));
    if (selected === undefined) throw new Error(`no space shows ${address}`);
    const before = docSpaces().map((space) => space.id);

    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: TEMPLATE }).click();

    // The run has answered once its tab is the selected one: the page shows the tab it opened for it.
    await expect.poll(agentAddress, { timeout: 20_000 }).not.toBeUndefined();
    const agent = agentAddress() ?? "";
    await expect(await tabOf(page, agent)).toHaveAttribute("aria-selected", "true", {
      timeout: (READY_AFTER_S + 30) * 1_000,
    });

    expect(docSpaces().map((space) => space.id)).toEqual(before);
    expect(spacesShowing(agent)).toEqual([selected.name]);
    expect(docSpaces().find((space) => space.id === selected.id)?.tabs).toHaveLength(2);
  } finally {
    rmSync(join(templates, `${TEMPLATE}.md`), { force: true });
    rmSync(script, { force: true });
  }
});
