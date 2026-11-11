import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { RELEASE_PUBLIC_KEYS, verifyRelease } from "@doriface/crypto";
import { HOST_VERSION } from "../host-types.ts";
import { describeOutcome } from "../self-update/schedule.ts";
import { selfUpdate, SelfUpdateError, UPDATE_ORIGIN, type UpdateChannel } from "../self-update/self-update.ts";
import { updaterId } from "../self-update/rollout.ts";
import { defaultStateDir } from "../state/files.ts";

export const UPDATE_USAGE = `usage: doriface-host update [--channel stable|beta] [--state-dir <dir>]
       doriface-host verify-release <SHA256SUMS.txt> <SHA256SUMS.txt.sig>`;

/** The channel a command line names, or why it names none. */
export function parseChannel(value: string, flag = "--channel"): UpdateChannel {
  if (value === "stable" || value === "beta") return value;
  throw new Error(`${flag} wants stable or beta, got ${JSON.stringify(value)}`);
}

/** The update origin: get.doriterm.com, or a self-hoster's own from DORIFACE_UPDATE_ORIGIN. */
export function updateOrigin(env: Readonly<Record<string, string | undefined>>): string {
  const given = env["DORIFACE_UPDATE_ORIGIN"];
  if (given === undefined || given === "") return UPDATE_ORIGIN;
  if (!URL.canParse(given) || new URL(given).protocol !== "https:") {
    throw new Error(`DORIFACE_UPDATE_ORIGIN wants an https origin, got ${JSON.stringify(given)}`);
  }
  return new URL(given).origin;
}

/** The binary to replace, only when this process is a built doriface-host: never bun running the source. */
export function updatableBinary(execPath: string): string | undefined {
  return /^doriface-host(?:-[a-z0-9-]+)?$/.test(basename(execPath)) ? execPath : undefined;
}

/** `doriface-host update`: one check, as the service runs it; exit 0 unless the check failed. */
export async function updateCommand(args: readonly string[], out: (text: string) => void): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: { channel: { type: "string", default: "stable" }, "state-dir": { type: "string" } },
  });
  const binary = updatableBinary(process.execPath);
  if (binary === undefined) {
    out(`doriface-host update: ${process.execPath} is not a built doriface-host, so there is nothing to replace\n`);
    return 1;
  }
  try {
    const outcome = await selfUpdate({
      channel: parseChannel(values.channel),
      origin: updateOrigin(process.env),
      currentVersion: HOST_VERSION,
      binary,
      updaterId: updaterId(values["state-dir"] ?? defaultStateDir()),
    });
    out(`${describeOutcome(outcome)}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof SelfUpdateError)) throw error;
    out(`doriface-host update: ${error.message}\n`);
    return 1;
  }
}

/** `doriface-host verify-release`: install.sh asks the binary it just checked whether SHA256SUMS.txt is signed. */
export async function verifyReleaseCommand(
  args: readonly string[],
  out: (text: string) => void,
  trusted: readonly string[] = RELEASE_PUBLIC_KEYS,
): Promise<number> {
  const [sums, signature] = args;
  if (sums === undefined || signature === undefined || args.length !== 2) throw new Error(UPDATE_USAGE);
  const ok = verifyRelease(await readFile(sums), await readFile(signature, "utf8"), trusted);
  out(
    ok
      ? "SHA256SUMS.txt is signed by a Doriterm release key\n"
      : "SHA256SUMS.txt is NOT signed by a Doriterm release key\n",
  );
  return ok ? 0 : 1;
}
