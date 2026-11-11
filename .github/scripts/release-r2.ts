#!/usr/bin/env bun
/**
 * The command line release.yml and release-channel.yml run against the release bucket (#1969).
 *
 *   mirror  --bucket B --origin O --version V --channel stable|beta --rollout N [--minimum M] --dir D --assets A --run-id R
 *           A is `gh release view <tag> --json assets` saved to a file; D holds the downloaded files (release-mirror.ts)
 *   channel --bucket B --origin O --channel stable|beta --op head|promote|rollback|yank [--version V] [--percent N]
 *   probe   --origin O --channel stable|beta --version V   waits up to five minutes for /dl to name V
 *
 * Secrets come from the environment and are never printed: R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (an R2 token
 * scoped to the one bucket), CLOUDFLARE_ACCOUNT_ID (the R2 endpoint) and RELEASE_SIGNING_KEY (base64 Ed25519 seed).
 */
import { parseArgs } from "node:util";
import { type Channel, isChannel, isVersion } from "../../apps/get/src/names.ts";
import { parseReleaseSecret, RELEASE_PUBLIC_KEYS } from "../../packages/crypto/src/release.ts";
import { R2Store } from "./r2-store.ts";
import { type Operation, runOperation } from "./release-channel.ts";
import { type GitHubAsset, mirrorRelease } from "./release-mirror.ts";

const fail = (message: string): never => {
  console.log(`::error title=Release bucket::${message}`);
  process.exit(1);
};

const env = (name: string): string => process.env[name] || fail(`${name} is not set`);

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: Object.fromEntries(
    ["bucket", "origin", "version", "channel", "rollout", "minimum", "dir", "assets", "run-id", "op", "percent"].map(
      (name) => [name, { type: "string" }] as const,
    ),
  ),
});
const arg = (name: string): string => {
  const value = values[name];
  return typeof value === "string" && value !== "" ? value : fail(`--${name} is required`);
};
const channelArg = (): Channel => {
  const channel = arg("channel");
  return isChannel(channel) ? channel : fail(`--channel must be stable or beta, not ${channel}`);
};
const versionArg = (): string => {
  const version = arg("version").replace(/^v/, "");
  return isVersion(version) ? version : fail(`--version ${version} is not X.Y.Z[-pre]`);
};
const origin = (): string => {
  const value = arg("origin");
  return /^https:\/\/[a-z0-9.-]+$/.test(value) ? value : fail(`--origin ${value} is not an https origin`);
};
const store = () =>
  new R2Store({
    endpoint: `https://${env("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    bucket: arg("bucket"),
    accessKeyId: env("R2_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
  });
const percent = (name: string): number => {
  const value = Number(arg(name));
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : fail(`--${name} must be 0 to 100`);
};

async function probe(): Promise<void> {
  const channel = channelArg();
  const version = versionArg();
  const url = `${origin()}/dl/${channel === "beta" ? "beta/" : ""}host-linux-x64`;
  const deadline = Date.now() + 5 * 60_000;
  const attempt = async (): Promise<void> => {
    const response = await fetch(url, { redirect: "manual", headers: { "User-Agent": "doriterm-install-qa mirror" } });
    const location = response.headers.get("location") ?? "";
    if (response.status === 302 && location.includes(`/v/${version}/`)) return console.log(`${url} -> ${location}`);
    if (Date.now() > deadline) fail(`${url} still answers ${response.status} ${location} after five minutes`);
    await Bun.sleep(10_000);
    return attempt();
  };
  await attempt();
}

const command = positionals[0];
const now = new Date().toISOString();
try {
  if (command === "mirror") {
    const listed: unknown = await Bun.file(arg("assets")).json();
    const raw: unknown = typeof listed === "object" && listed !== null ? Reflect.get(listed, "assets") : undefined;
    const assets: GitHubAsset[] = (Array.isArray(raw) ? raw : []).map((entry: unknown) => ({
      name: String(typeof entry === "object" && entry !== null ? Reflect.get(entry, "name") : ""),
      digest: String(typeof entry === "object" && entry !== null ? Reflect.get(entry, "digest") : ""),
    }));
    const minimum = values["minimum"];
    if (minimum !== undefined && minimum !== "" && !isVersion(minimum)) fail(`--minimum ${minimum} is not a version`);
    await mirrorRelease(
      store(),
      {
        version: versionArg(),
        channel: channelArg(),
        rollout: percent("rollout"),
        runId: arg("run-id"),
        now,
        origin: origin(),
        dir: arg("dir"),
        assets,
        secretKey: parseReleaseSecret(env("RELEASE_SIGNING_KEY")),
        trustedKeys: RELEASE_PUBLIC_KEYS,
        ...(minimum === undefined || minimum === "" ? {} : { minimum }),
      },
      (line) => console.log(line),
    );
  } else if (command === "channel") {
    const op = arg("op");
    const operation: Operation =
      op === "head"
        ? { op }
        : op === "promote"
          ? { op, version: versionArg(), percent: percent("percent") }
          : op === "rollback" || op === "yank"
            ? { op, version: versionArg() }
            : fail(`--op must be head, promote, rollback or yank, not ${op}`);
    const needsKey = operation.op !== "head";
    console.log(
      await runOperation(
        {
          store: store(),
          channel: channelArg(),
          origin: origin(),
          secretKey: needsKey ? parseReleaseSecret(env("RELEASE_SIGNING_KEY")) : new Uint8Array(32),
          now,
        },
        operation,
      ),
    );
  } else if (command === "probe") {
    await probe();
  } else {
    fail("usage: release-r2.ts mirror|channel|probe (see the header)");
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  fail(error.message.replaceAll("\n", " "));
}
