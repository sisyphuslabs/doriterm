import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG = join(import.meta.dir, "..", "..", "..", "apps", "desktop", "electron-builder.json");

const config = JSON.parse(readFileSync(CONFIG, "utf8")) as { executableName?: string };

/**
 * The packaged app's executable, as `executableName` in apps/desktop/electron-builder.json names it. Without the key,
 * electron-builder would name the Linux binary after the package instead, so a check built on it would compare against
 * `.../undefined`: this fails first and names the key (#1814).
 */
export function executableName(): string {
  const name = config.executableName;
  if (name === undefined || name === "") {
    throw new Error("apps/desktop/electron-builder.json has no executableName, which the desktop CI jobs launch");
  }
  return name;
}
