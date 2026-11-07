import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", ".github", "scripts", "playwright-linux-deps.sh");

// The script runs on Ubuntu runners: it needs a bash with mapfile (4+), which macOS's /bin/bash is not.
const bash = Bun.spawnSync(["bash", "-c", "type mapfile"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
if (!bash) console.warn("playwright-linux-deps: skipped, the bash on PATH has no mapfile (bash 4+ needed)");

interface Apt {
  /**
   * Playwright's list at the runner's candidate versions: what `install --no-download` asks the archive for, what
   * `install-deps --dry-run` requires installed, and what the mirror downloads for any of them not installed yet.
   */
  readonly candidates: readonly string[];
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the script against stub sudo, apt-get, dpkg-deb, dpkg-query, bunx and timeout; package files are
 * <package>_<version>.deb, and the installed packages are lines of "<package> <version>".
 */
function run(cached: readonly string[], apt: Apt): { save: string; cache: string[]; mirrorInstalls: number } {
  const root = mkdtempSync(join(tmpdir(), "pw-deps-"));
  dirs.push(root);
  const debs = join(root, "debs");
  const archives = join(root, "archives");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  const installed = join(root, "installed");
  writeFileSync(installed, "");
  const candidates = apt.candidates.join(" ");
  mkdirSync(bin);
  mkdirSync(archives);
  if (cached.length > 0) mkdirSync(debs);
  for (const deb of cached) writeFileSync(join(debs, deb), "");
  const stubs: Record<string, string> = {
    sudo: 'exec "$@"',
    timeout: 'shift; exec "$@"',
    "dpkg-deb": 'f=$(basename "$2" .deb); case "$3" in Package) echo "${f%%_*}" ;; Version) echo "${f#*_}" ;; esac',
    "dpkg-query": `v=$(grep "^\${@: -1} " "${installed}" | cut -d' ' -f2); [ -n "$v" ] || exit 1; printf %s "$v"`,
    "apt-get": [
      `echo "apt-get $*" >> "${log}"`,
      `case " $* " in *" clean "*) rm -f "${archives}"/*.deb; exit 0 ;; esac`,
      // apt resolves each requested name to its candidate and, with --no-download, fails unless the archive holds it.
      `case " $* " in *" --no-download "*)`,
      `  wants=(); for name in "$@"; do case "$name" in -*|install) continue ;; esac`,
      `    want=""; for c in ${candidates}; do [ "\${c%%_*}" = "$name" ] && want=$c; done`,
      `    [ -n "$want" ] && [ -f "${archives}/$want.deb" ] || exit 100; wants+=("$want"); done`,
      `  for want in "\${wants[@]}"; do echo "\${want%%_*} \${want#*_}" >> "${installed}"; done ;; esac`,
      "exit 0",
    ].join("\n"),
    bunx: [
      `echo "bunx $*" >> "${log}"`,
      `case " $* " in *" --dry-run "*) for c in ${candidates}; do grep -qx "\${c%%_*} \${c#*_}" "${installed}" || exit 1; done; exit 0 ;; esac`,
      // The mirror install downloads only what is not installed at its candidate version yet.
      `for c in ${candidates}; do grep -qx "\${c%%_*} \${c#*_}" "${installed}" && continue; : > "${archives}/$c.deb"; echo "\${c%%_*} \${c#*_}" >> "${installed}"; done`,
    ].join("\n"),
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const output = join(root, "github-output");
  const result = Bun.spawnSync(["bash", SCRIPT, debs], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      GITHUB_OUTPUT: output,
      PLAYWRIGHT_APT_ARCHIVES: archives,
      PLAYWRIGHT_APT_CONF: join(root, "99-playwright-ci"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`script exited ${String(result.exitCode)}: ${result.stderr.toString()}`);
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
  return {
    save: readFileSync(output, "utf8").trim(),
    cache: existsSync(debs) ? readdirSync(debs).toSorted() : [],
    mirrorInstalls: calls.split("\n").filter((line) => line.startsWith("bunx playwright install-deps chromium")).length,
  };
}

test.skipIf(!bash)("a cache that covers the runner's candidates installs without the mirror and is kept", () => {
  const found = run(["fonts-a_1.deb"], { candidates: ["fonts-a_1"] });
  expect(found).toEqual({ save: "save-debs=false", cache: ["fonts-a_1.deb"], mirrorInstalls: 0 });
});

// doriterm#1022: an archive update makes the cached version stale; the mirror install that follows refills the cache.
test.skipIf(!bash)("a stale cache falls back to the mirror and is saved again with what the mirror served", () => {
  const found = run(["fonts-a_1.deb"], { candidates: ["fonts-a_2"] });
  expect(found).toEqual({ save: "save-debs=true", cache: ["fonts-a_2.deb"], mirrorInstalls: 1 });
});

// A list that grows past the cache (a runner image that stops shipping a package): the cached files still install, the
// mirror adds only the missing one, and the saved set is the whole list, so the next run needs no mirror at all.
test.skipIf(!bash)("a cache that covers only part of the list keeps its files and gains the missing one", () => {
  const found = run(["fonts-a_1.deb", "fonts-b_1.deb"], { candidates: ["fonts-a_1", "fonts-b_1", "fonts-c_1"] });
  expect(found).toEqual({
    save: "save-debs=true",
    cache: ["fonts-a_1.deb", "fonts-b_1.deb", "fonts-c_1.deb"],
    mirrorInstalls: 1,
  });
});

test.skipIf(!bash)("an empty cache is filled from the mirror", () => {
  const found = run([], { candidates: ["fonts-a_1"] });
  expect(found).toEqual({ save: "save-debs=true", cache: ["fonts-a_1.deb"], mirrorInstalls: 1 });
});
