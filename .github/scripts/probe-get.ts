#!/usr/bin/env bun
/**
 * Probes a deployed get.doriterm.com Worker (#1969): /healthz answers ok, /stats/downloads answers its JSON with CORS
 * open, the download page answers a browser, and `/` gives curl an installer (the stable install.sh, or before the
 * first mirror a redirect to GitHub's). Retries for up to five minutes while a new custom domain gets its certificate.
 *
 * Usage: bun .github/scripts/probe-get.ts <origin>
 */
const origin = Bun.argv[2]?.replace(/\/$/, "");
if (origin === undefined || !/^https:\/\/[a-z0-9.-]+$/.test(origin)) {
  console.error("usage: probe-get.ts https://<host>");
  process.exit(2);
}

interface Check {
  readonly name: string;
  readonly path: string;
  readonly userAgent: string;
  readonly ok: (response: Response, body: string) => boolean;
}

const CHECKS: readonly Check[] = [
  { name: "healthz", path: "/healthz", userAgent: "doriterm-install-qa probe", ok: (r, b) => r.ok && b === "ok\n" },
  {
    name: "stats",
    path: "/stats/downloads",
    userAgent: "doriterm-install-qa probe",
    ok: (r, b) => r.ok && r.headers.get("access-control-allow-origin") === "*" && /"downloads":\d+/.test(b),
  },
  {
    name: "download page",
    path: "/",
    userAgent: "Mozilla/5.0 doriterm-install-qa probe",
    ok: (r, b) => r.ok && b.includes("/dl/mac-arm64.dmg"),
  },
  {
    name: "installer",
    path: "/",
    userAgent: "curl doriterm-install-qa probe",
    ok: (r, b) =>
      (r.status === 200 && b.startsWith("#!")) ||
      (r.status === 302 && (r.headers.get("location") ?? "").endsWith("/releases/latest/download/install.sh")),
  },
];

async function failures(): Promise<string[]> {
  const results = await Promise.all(
    CHECKS.map(async (check) => {
      try {
        const response = await fetch(`${origin}${check.path}`, {
          headers: { "User-Agent": check.userAgent },
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        return check.ok(response, await response.text()) ? null : `${check.name}: ${response.status}`;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return `${check.name}: ${error.message}`;
      }
    }),
  );
  return results.filter((result) => result !== null);
}

const deadline = Date.now() + 5 * 60_000;

async function probe(): Promise<number> {
  const failing = await failures();
  if (failing.length === 0) {
    console.log(`${origin} answers: ${CHECKS.map((check) => check.name).join(", ")}`);
    return 0;
  }
  if (Date.now() > deadline) {
    console.log(`::error title=Probe ${origin}::${failing.join("; ")}`);
    return 1;
  }
  console.log(`waiting for ${origin}: ${failing.join("; ")}`);
  await Bun.sleep(10_000);
  return probe();
}

process.exit(await probe());
