import { parseSkillStatus, type SkillStatus } from "./agent-skill.ts";
import { isJsonObject, type JsonValue } from "./json.ts";

/** The herdr document each doriface-host writes on its own core, saying what that machine is. */
export const HOST_INFO_DOC = "doriface-host";

/** The operating systems a host reports, as Node's `process.platform` names them. */
export type HostOs = "darwin" | "linux" | "win32";

/** The `doriface-host` document: version 1. A newer host may add members; a reader takes the ones it knows. */
export interface HostInfo {
  readonly v: 1;
  readonly os: HostOs;
  /** Where the Doriterm agent skill stands on this machine; absent from a host older than it. */
  readonly skill?: SkillStatus;
}

const OSES: ReadonlySet<string> = new Set<HostOs>(["darwin", "linux", "win32"]);

const isHostOs = (value: unknown): value is HostOs => typeof value === "string" && OSES.has(value);

/** The document for a host on `platform`, or undefined on an OS outside {@link HostOs} (it writes none). */
export const hostInfoFor = (platform: string): HostInfo | undefined =>
  isHostOs(platform) ? { v: 1, os: platform } : undefined;

/** A `doriface-host` document's value, or undefined when it is absent (`null`), of another version, or malformed. */
export function parseHostInfo(value: JsonValue): HostInfo | undefined {
  if (!isJsonObject(value) || value["v"] !== 1) return undefined;
  const os = value["os"];
  if (!isHostOs(os)) return undefined;
  const skill = parseSkillStatus(value["skill"]);
  return skill === undefined ? { v: 1, os } : { v: 1, os, skill };
}
