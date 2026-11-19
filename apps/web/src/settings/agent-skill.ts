import type { HcConnection } from "@doriface/client";
import {
  HcRpcError,
  HOST_INFO_DOC,
  isJsonObject,
  parseHostInfo,
  parseSkillRequestDoc,
  parseSkillStatus,
  SKILL_REQUEST_DOC,
  type SkillStatus,
} from "@doriface/protocol";
import type { DocHeard } from "../roster/roster.ts";

/** What a machine's row says about the agent skill, and the one action it offers. */
export interface SkillLine {
  readonly text: string;
  readonly action: "install" | "update" | null;
}

const versioned = (word: string, version: string | undefined): string =>
  version === undefined ? word : `${word} v${version}`;

/**
 * The row's line for what a host reported: `undefined` for a host older than the skill. Install writes only the missing
 * directories and never touches a foreign one, so a mix of foreign and missing still offers it.
 */
export function skillLine(skill: SkillStatus | undefined): SkillLine | null {
  if (skill === undefined) return { text: "Agent skill not reported (its host is older than the skill)", action: null };
  if (skill.bundled === null) return { text: "This host build has no agent skill", action: null };
  const outdated = skill.dirs.find((dir) => dir.state === "outdated");
  if (outdated !== undefined) {
    return {
      text: `Agent skill outdated${outdated.version === undefined ? "" : ` (v${outdated.version})`}`,
      action: "update",
    };
  }
  if (skill.dirs.some((dir) => dir.state === "missing"))
    return { text: "Agent skill not installed", action: "install" };
  const installed = skill.dirs.find((dir) => dir.state === "installed");
  if (installed !== undefined) return { text: versioned("Agent skill installed", installed.version), action: null };
  if (skill.dirs.length > 0) return { text: "Agent skill not managed by Doriterm", action: null };
  return null;
}

type Call = Pick<HcConnection, "call">["call"];

/** The calls and document events a skill read or request needs: a connection and the roster of its core. */
export interface SkillLink {
  readonly call: Call;
  readonly onDoc: (listener: DocHeard) => () => void;
  readonly onGap: (listener: () => void) => () => void;
}

const where = (machine: string | undefined) => (machine === undefined ? {} : { on: machine });

/** What a machine's host reports about the skill: `{skill}` (absent from an older host), or null when the read failed. */
export async function readSkill(
  link: Pick<SkillLink, "call">,
  machine: string | undefined,
): Promise<{ readonly skill: SkillStatus | undefined } | null> {
  try {
    const doc = await link.call("doc.get", { name: HOST_INFO_DOC, ...where(machine) });
    const info = parseHostInfo(doc.value);
    return info === undefined ? null : { skill: info.skill };
  } catch {
    // An offline machine or an older core: the row shows nothing rather than an error.
    return null;
  }
}

const conflict = (error: unknown): boolean => error instanceof HcRpcError && error.kind === "conflict";

async function writeRequest(link: SkillLink, machine: string | undefined, request: string): Promise<void> {
  const write = async (): Promise<void> => {
    const { version } = await link.call("doc.get", { name: SKILL_REQUEST_DOC, ...where(machine) });
    await link.call("doc.set", { name: SKILL_REQUEST_DOC, value: { request }, version, ...where(machine) });
  };
  try {
    await write();
  } catch (error) {
    // Another write came first: read the version it left and write once more.
    if (!conflict(error)) throw error;
    await write();
  }
}

export const SKILL_ANSWER_MS = 60_000;

/**
 * Asks a machine's host to install or update the skill and settles with the status it answers, or rejects with the
 * host's error. The answer is read when the request document changes or the feed has a gap, never on a timer; a host
 * that never answers rejects after `timeoutMs`.
 */
export function requestSkill(
  link: SkillLink,
  machine: string | undefined,
  timeoutMs = SKILL_ANSWER_MS,
  request: string = crypto.randomUUID(),
): Promise<SkillStatus> {
  return new Promise((resolve, reject) => {
    let open = true;
    let written = false;
    const finish = (settle: () => void): void => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      for (const stop of stops) stop();
      settle();
    };
    const fail = (error: unknown): void =>
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    const check = async (): Promise<void> => {
      try {
        const doc = await link.call("doc.get", { name: SKILL_REQUEST_DOC, ...where(machine) });
        const answer = doc.value === null ? undefined : parseSkillRequestDoc(doc.value);
        // A request another client wrote over ours is answered by the same install, so its answer is ours too.
        if (answer === undefined || !written) return;
        if ("error" in answer) {
          fail(answer.error);
          return;
        }
        const done = isJsonObject(doc.value) ? parseSkillStatus(doc.value["done"]) : undefined;
        if (done !== undefined) finish(() => resolve(done));
      } catch (error) {
        fail(error);
      }
    };
    const stops = [
      link.onDoc((on, name) => (on === (machine ?? null) && name === SKILL_REQUEST_DOC ? void check() : undefined)),
      link.onGap(() => void check()),
    ];
    const timer = setTimeout(() => fail("The host did not answer. Try again."), timeoutMs);
    writeRequest(link, machine, request).then(() => {
      written = true;
      return check();
    }, fail);
  });
}
