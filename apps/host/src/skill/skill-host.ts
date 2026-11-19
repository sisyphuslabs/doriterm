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

export interface InstallOutcome {
  /** Where the skill stands after the attempt, the directories that failed included. */
  readonly status: SkillStatus;
  /** One line per directory that could not be written. */
  readonly failures: readonly string[];
}

/** The agent skill as a running host manages it: in the directories found on the machine at each call. */
export interface AgentSkill {
  status(): Promise<SkillStatus>;
  /** Installs where missing, updates where outdated, and answers the status after. */
  install(): Promise<InstallOutcome>;
  /** Updates the copies an older host wrote, and writes nothing new: what a host does once it runs a newer version. */
  refreshOutdated(): Promise<readonly DirResult<InstallAction>[]>;
}

const failuresOf = (results: readonly DirResult<InstallAction>[]): string[] =>
  results.filter((result) => result.action === "failed").map((result) => `${result.dir}: ${result.error ?? "failed"}`);

/** The host's writes run one after another, so a request and the update after a self-update never race each other. */
export function agentSkill(
  bundle: SkillBundle,
  targets: () => readonly SkillTarget[],
  now: () => Date = () => new Date(),
): AgentSkill {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    status: () => skillStatus(bundle, targets()),
    install: () =>
      serial(async () => {
        const results = await installSkill(bundle, targets(), now);
        return { status: await skillStatus(bundle, targets()), failures: failuresOf(results) };
      }),
    refreshOutdated: () =>
      bundle.files.length === 0 ? Promise.resolve([]) : serial(() => installSkill(bundle, targets(), now, true)),
  };
}

const isConflict = (error: unknown): boolean => error instanceof HcRpcError && error.kind === "conflict";

/** What a running host does with its agent skill; its facts are written again only after the skill changed. */
export function skillHooks(skill: AgentSkill, refreshInfo: () => void, log: (line: string) => void) {
  const answering = new Set<string>();
  return {
    status: () => skill.status(),
    answer: async (store: DocStore): Promise<void> => {
      if ((await answerSkillRequest(store, skill, answering)) === "answered") refreshInfo();
    },
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
      for (const failure of failuresOf(results)) log(`agent skill: cannot update ${failure}`);
      if (updated.length === 0) return;
      log(`agent skill: updated ${updated.join(", ")}`);
      refreshInfo();
    },
  };
}

/**
 * Answers a client's Install or Update: a `{request}` in the `doriface-skill` document on this host's core installs the
 * skill and is answered in place with `done` and the status after it, or `error` naming the directories that failed.
 * A request already answered is left alone, so the host's own write (a doc event too) installs nothing.
 */
export async function answerSkillRequest(
  store: DocStore,
  skill: Pick<AgentSkill, "install">,
  answering: Set<string> = new Set(),
): Promise<"answered" | "skipped"> {
  const doc = await store.get(SKILL_REQUEST_DOC);
  const current = parseSkillRequestDoc(doc.value);
  if (current === undefined || "done" in current || "error" in current || answering.has(current.request))
    return "skipped";
  const { request } = current;
  answering.add(request);
  try {
    const answer = await skill.install().then(
      ({ status, failures }) =>
        failures.length === 0 ? { request, done: status } : { request, error: failures.join("; ") },
      (error: unknown) => ({ request, error: error instanceof Error ? error.message : String(error) }),
    );
    const latest = await store.get(SKILL_REQUEST_DOC);
    if (parseSkillRequestDoc(latest.value)?.request === request) {
      await store.set(SKILL_REQUEST_DOC, answer, latest.version).catch((error: unknown) => {
        if (!isConflict(error)) throw error;
      });
    }
    return "answered";
  } finally {
    answering.delete(request);
  }
}
