// #218: a space row says its git state only when it is unusual, from the facts the machine's doriface-host writes on
// its core for the directories its terminals sit in.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { E2E_HOST_ENV } from "./config.ts";
import { readSavedEnv } from "./saved-env.ts";
import { rows } from "./sidebar-measure.ts";

test.use({ serviceWorkers: "block" });

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args], {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
};

/** A repository on `main` with one commit. */
function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README"), "e2e\n");
  git(dir, "add", "README");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

/** Starts an idle session in `cwd`, in the space `space`, and returns its address. */
function startIn(cwd: string, space: string): string {
  const { hc, env } = readSavedEnv(E2E_HOST_ENV);
  const out = execFileSync(hc, ["run", "--bg", "--json", "--label", `space=${space}`, "--", "sleep", "3600"], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  const address: unknown = Reflect.get(JSON.parse(out) as object, "address");
  if (typeof address !== "string") throw new Error(`hc run in ${cwd} printed no address`);
  return address;
}

function stop(addresses: readonly string[]): void {
  for (const address of addresses) endAgent("host", address);
}

test("a space row shows its branch, ahead and uncommitted changes, or detached, and nothing on a clean main", async ({
  page,
}, testInfo) => {
  const root = testInfo.outputPath("repos");
  const feature = repo(join(root, "feature"));
  git(feature, "checkout", "-q", "-b", "feat/rows");
  writeFileSync(join(feature, "change"), "one\n");
  git(feature, "add", "change");
  git(feature, "commit", "-q", "-m", "ahead");
  git(feature, "branch", "-q", "--set-upstream-to=main");
  writeFileSync(join(feature, "untracked"), "dirty\n");
  const clean = repo(join(root, "clean"));
  const detached = repo(join(root, "detached"));
  git(detached, "checkout", "-q", "--detach", "HEAD");

  const dirs = { "git-feature": feature, "git-clean": clean, "git-detached": detached };
  const addresses = Object.entries(dirs).map(([space, dir]) => startIn(dir, space));
  try {
    // The sidebar lists the layout's spaces (#404): each named, on its repository's folder, showing its session.
    seedSpaces(
      Object.entries(dirs).map(([name, folder], index) => ({
        id: `spc-${name}`,
        name,
        folder,
        tabs: [{ id: `tb-${name}`, name: "", terminal: addresses[index] ?? "" }],
      })),
    );
    await page.goto("/");
    const spaces = page.getByRole("region", { name: "Spaces" });
    const row = (space: string) => rows(spaces).filter({ hasText: space });
    // Both rows must be ready together, within the budget the feature row already had. A feature-only tick says
    // nothing about detached: a slow git read can omit it until a later document (#1209).
    await expect
      .poll(
        () =>
          Promise.all(
            ["git-feature", "git-detached"].map((space) => row(space).locator("[data-git]").allTextContents()),
          ),
        { timeout: 45_000 },
      )
      .toEqual([["feat/rows* ↑1"], ["detached"]]);
    await expect(row("git-feature").locator("[data-git]")).toHaveAttribute(
      "title",
      "On feat/rows, 1 commit ahead, uncommitted changes",
    );
    await expect(row("git-clean")).toBeVisible();
    await expect(row("git-clean").locator("[data-git]")).toHaveCount(0);
  } finally {
    stop(addresses);
  }
});
