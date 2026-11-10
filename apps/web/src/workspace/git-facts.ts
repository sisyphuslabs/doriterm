import type { HcConnection } from "@doriface/client";
import { GIT_FACTS_DOC, type GitFacts, type GitFactsDoc, type MachineView, parseGitFacts } from "@doriface/protocol";
import type { SpaceGit } from "@doriface/ui";
import { createContext, use, useCallback, useEffect, useState } from "react";

/** How often the page reads the facts again; the host writes them on its own cadence. */
const READ_MS = 5_000;

/**
 * How many reads in a row one machine may fail and still keep its last document: at one every 5 s, 15 rounds are the
 * 75 s this page holds a redialing line as connected (#904), so the facts outlast a redial blip (#913) and no longer. A
 * failure that persists past it, such as an RPC error on one machine's call while its line is up, drops the stale branch
 * and diff facts instead of showing them for as long as the machine reads connected (#1165).
 */
export const FAILED_ROUNDS_KEPT = 15;

/** A directory's git facts on a machine (undefined for this one), when its host wrote them. */
export type GitFactsOf = (machine: string | undefined, dir: string) => GitFacts | undefined;

/** What a space row says about its git state: nothing on its default branch, in sync and clean. */
export function shownGit(facts: GitFacts | undefined): SpaceGit | undefined {
  if (facts === undefined) return undefined;
  const { branch, detached, onDefault, ahead, behind, dirty } = facts;
  if (!detached && !dirty && ahead === 0 && behind === 0 && onDefault) return undefined;
  const git = { detached, ahead, behind, dirty };
  return branch === undefined ? git : { branch, ...git };
}

export const GitFactsContext = createContext<GitFactsOf>(() => undefined);

export const useGitFactsOf = (): GitFactsOf => use(GitFactsContext);

/** One machine's read: the document it holds (undefined when it has none), or "failed" when it could not be asked. */
export type FactsRead = readonly [machine: string, read: GitFactsDoc | undefined | "failed"];

/** The documents after a round of reads, and each machine's run of failed reads in a row. */
export interface FactsRounds {
  readonly docs: ReadonlyMap<string, GitFactsDoc>;
  readonly misses: ReadonlyMap<string, number>;
}

/**
 * The round after `reads`. A read that could not be made (a mesh line redialing, held as connected by the grace from
 * #904) keeps the machine's last document, as the layout documents keep theirs, so its rows do not lose their git facts
 * for a blip (#913), but only for a run of failed rounds, so a failure that outlasts the grace drops them (#1165). A
 * machine that answers with no document has none, and one no longer asked (gone from the list, or offline past the
 * grace) is dropped.
 */
export function nextDocs(
  before: ReadonlyMap<string, GitFactsDoc>,
  misses: ReadonlyMap<string, number>,
  reads: readonly FactsRead[],
): FactsRounds {
  const docs = new Map<string, GitFactsDoc>();
  const nextMisses = new Map<string, number>();
  for (const [machine, read] of reads) {
    if (read !== "failed") {
      if (read !== undefined) docs.set(machine, read);
      continue;
    }
    const doc = before.get(machine);
    const missed = (misses.get(machine) ?? 0) + 1;
    if (doc === undefined || missed > FAILED_ROUNDS_KEPT) continue;
    docs.set(machine, doc);
    nextMisses.set(machine, missed);
  }
  return { docs, misses: nextMisses };
}

/** The documents each connected machine's doriface-host (and this machine's) wrote, read again every few seconds. */
export function useGitFacts(connection: HcConnection, machines: readonly MachineView[]): GitFactsOf {
  const names = machines
    .filter((machine) => machine.state === "connected")
    .map((machine) => machine.name)
    .join("\u0000");
  const [rounds, setRounds] = useState<FactsRounds>(() => ({ docs: new Map(), misses: new Map() }));
  const docs = rounds.docs;
  useEffect(() => {
    let live = true;
    const want = ["", ...(names === "" ? [] : names.split("\u0000"))];
    const read = async (): Promise<void> => {
      const results = await Promise.all(
        want.map(async (machine): Promise<FactsRead> => {
          try {
            const doc = await connection.call(
              "doc.get",
              machine === "" ? { name: GIT_FACTS_DOC } : { name: GIT_FACTS_DOC, on: machine },
            );
            return [machine, parseGitFacts(doc.value)];
          } catch {
            return [machine, "failed"];
          }
        }),
      );
      if (!live) return;
      setRounds((before) => {
        const next = nextDocs(before.docs, before.misses, results);
        const same =
          JSON.stringify([...before.docs]) === JSON.stringify([...next.docs]) &&
          JSON.stringify([...before.misses]) === JSON.stringify([...next.misses]);
        return same ? before : next;
      });
    };
    void read();
    const timer = setInterval(() => void read(), READ_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [connection, names]);
  return useCallback((machine, dir) => docs.get(machine ?? "")?.dirs[dir], [docs]);
}
