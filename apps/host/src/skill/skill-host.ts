import { HcRpcError, parseSkillRequestDoc, SKILL_REQUEST_DOC, type SkillStatus } from "@doriface/protocol";
import type { DocStore } from "../mesh/status-doc.ts";
import {
  type DirResult,
  type InstallAction,
  installSkill,
  type SkillBundle,
  skillStatus,
  type SkillTarget,
} from "./agent-skill.ts";

/** The agent skill as a running host manages it: in the directories found on the machine at each call. */
export interface AgentSkill {
  status(): Promise<SkillStatus>;
  /** Installs where missing, updates where outdated, and answers the status after. */
  install(): Promise<SkillStatus>;
  /** Updates the copies an older host wrote, and writes nothing new: what a host does once it runs a newer version. */
  refreshOutdated(): Promise<readonly DirResult<InstallAction>[]>;
}

export function agentSkill(
  bundle: SkillBundle,
  targets: () => readonly SkillTarget[],
  now: () => Date = () => new Date(),
): AgentSkill {
  return {
    status: () => skillStatus(bundle, targets()),
    async install() {
      await installSkill(bundle, targets(), now);
      return skillStatus(bundle, targets());
    },
    refreshOutdated: () =>
      bundle.files.length === 0 ? Promise.resolve([]) : installSkill(bundle, targets(), now, true),
  };
}

const isConflict = (error: unknown): boolean => error instanceof HcRpcError && error.kind === "conflict";

/** What a running host does with its agent skill, each followed by a new write of its facts (`refreshInfo`). */
export function skillHooks(skill: AgentSkill, refreshInfo: () => void, log: (line: string) => void) {
  const answering = new Set<string>();
  return {
    status: () => skill.status(),
    answer: (store: DocStore) => answerSkillRequest(store, skill, answering).then(refreshInfo),
    changed: refreshInfo,
    /** Updates the copies an older host wrote; a host that updated itself starts here. */
    async refreshOutdated(): Promise<void> {
      let results: readonly DirResult<InstallAction>[];
      try {
        results = await skill.refreshOutdated();
      } catch (error) {
        log(`agent skill: cannot update the copies an older host wrote: ${String(error)}`);
        return;
      }
      const updated = results.filter((result) => result.action === "updated").map((result) => result.dir);
      if (updated.length > 0) log(`agent skill: updated ${updated.join(", ")}`);
      refreshInfo();
    },
  };
}

/**
 * Answers a client's Install or Update: a `{request}` in the `doriface-skill` document on this host's core installs the
 * skill and is answered in place with `done` and the status after it, or `error`. A request already answered is left
 * alone, so the host's own write (a doc event too) installs nothing. Settles true when it installed.
 */
export async function answerSkillRequest(
  store: DocStore,
  skill: Pick<AgentSkill, "install">,
  answering: Set<string> = new Set(),
): Promise<boolean> {
  const doc = await store.get(SKILL_REQUEST_DOC);
  const current = parseSkillRequestDoc(doc.value);
  if (current === undefined || "done" in current || "error" in current || answering.has(current.request)) return false;
  const { request } = current;
  answering.add(request);
  try {
    const answer = await skill.install().then(
      (done) => ({ request, done }),
      (error: unknown) => ({ request, error: error instanceof Error ? error.message : String(error) }),
    );
    const latest = await store.get(SKILL_REQUEST_DOC);
    if (parseSkillRequestDoc(latest.value)?.request !== request) return "done" in answer;
    await store.set(SKILL_REQUEST_DOC, answer, latest.version).catch((error: unknown) => {
      if (!isConflict(error)) throw error;
    });
    return "done" in answer;
  } finally {
    answering.delete(request);
  }
}
