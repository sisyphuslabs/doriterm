import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DL_KEYS } from "../../apps/get/src/names.ts";
import { INSTALL_SCRIPT_URL, joinCommand } from "../../apps/web/src/workspace/join-command.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const PAGES = ["README.md", "docs/getting-started.md", "docs/install.md", "apps/landing/index.html"];

test("every get.doriterm.com/dl link in the docs and the landing page names a key the Worker serves", () => {
  const links = PAGES.flatMap((path) =>
    Array.from(read(path).matchAll(/https:\/\/get\.doriterm\.com\/dl\/([^)\s"'\]]+)/g)),
  );
  expect(links.length).toBeGreaterThan(20);
  const unknown = links.map((match) => match[1] ?? "").filter((key) => !DL_KEYS.includes(key.replace(/^beta\//, "")));
  expect(unknown).toEqual([]);
});

test("the install line, the Add a machine command and the landing page's download all point at get.doriterm.com", () => {
  expect(read("README.md")).toContain("curl -fsSL https://get.doriterm.com | sh");
  expect(read("README.md")).not.toContain("releases/latest/download/install.sh");
  expect(INSTALL_SCRIPT_URL).toBe("https://get.doriterm.com");
  expect(joinCommand("doriface://pair#h=a")).toStartWith("curl -fsSL https://get.doriterm.com |");
  const landing = read("apps/landing/index.html");
  expect(landing).toContain('<a class="btn btn--ghost" href="https://get.doriterm.com"');
  expect(landing).toContain("data-downloads hidden");
});

test("the landing page may read the download count and nothing else off its own origin", () => {
  const csp = read("apps/landing/public/_headers").match(/Content-Security-Policy: (.*)/)?.[1] ?? "";
  const connect = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("connect-src"));
  expect(connect).toBe("connect-src 'self' https://get.doriterm.com");
  expect(read("apps/landing/main.js")).toContain('fetch("https://get.doriterm.com/stats/downloads")');
});
