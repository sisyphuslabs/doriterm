import type { HcConnection } from "@doriface/client";
import { GIT_FACTS_DOC, type GitFacts, type GitFactsDoc, type MachineView, parseGitFacts } from "@doriface/protocol";
import type { SpaceGit } from "@doriface/ui";
import { createContext, use, useCallback, useEffect, useState } from "react";

/** How often the page reads the facts again; the host writes them on its own cadence. */
const READ_MS = 5_000;

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

/**
 * The documents after a round of reads. A read that could not be made (a mesh line redialing, held as connected by the
 * grace from #904) keeps the machine's last document, as the layout documents keep theirs, so its rows do not lose their
 * git facts for a blip (#913). A machine that answers with no document has none, and one no longer asked (gone from the
 * list, or offline past the grace) is dropped.
 */
export function nextDocs(
  before: ReadonlyMap<string, GitFactsDoc>,
  reads: readonly FactsRead[],
): ReadonlyMap<string, GitFactsDoc> {
  const next = new Map<string, GitFactsDoc>();
  for (const [machine, read] of reads) {
    const doc = read === "failed" ? before.get(machine) : read;
    if (doc !== undefined) next.set(machine, doc);
  }
  return next;
}

/** The documents each connected machine's doriface-host (and this machine's) wrote, read again every few seconds. */
export function useGitFacts(connection: HcConnection, machines: readonly MachineView[]): GitFactsOf {
  const names = machines
    .filter((machine) => machine.state === "connected")
    .map((machine) => machine.name)
    .join("\u0000");
  const [docs, setDocs] = useState<ReadonlyMap<string, GitFactsDoc>>(new Map());
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
      setDocs((before) => {
        const next = nextDocs(before, results);
        return JSON.stringify([...before]) === JSON.stringify([...next]) ? before : next;
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
