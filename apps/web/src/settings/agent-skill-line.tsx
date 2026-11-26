import type { HcConnection } from "@doriface/client";
import { HOST_INFO_DOC, type SkillStatus } from "@doriface/protocol";
import { Button } from "@doriface/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { rosterFor } from "../roster/roster.ts";
import { readSkill, requestSkill, type SkillLink, skillLine } from "./agent-skill.ts";

type Read = { readonly skill: SkillStatus | undefined } | null;

/** A machine's row pieces for the agent skill: a line under its state and the Install or Update button. */
export interface SkillParts {
  readonly line: ReactNode;
  readonly action: ReactNode;
}

const NONE: SkillParts = { line: null, action: null };

/** Renders the skill line and action for what was read; pure, so a test can render each state. */
export function skillParts(
  read: Read,
  busy: boolean,
  error: string | undefined,
  onInstall: () => void,
  name: string,
): SkillParts {
  const line = read === null ? null : skillLine(read.skill);
  if (line === null) return NONE;
  const label = line.action === "update" ? "Update" : "Install";
  return {
    line: (
      <>
        <span className="block">{line.text}</span>
        {error === undefined ? null : <span className="block text-status-blocked-text">{error}</span>}
      </>
    ),
    action:
      line.action === null ? null : (
        <Button variant="secondary" loading={busy} aria-label={`${label} agent skill on ${name}`} onClick={onInstall}>
          {label}
        </Button>
      ),
  };
}

/**
 * The agent skill of the machine a connection reaches (`machine` on its core, or the core's own host), read again when
 * its host rewrites the `doriface-host` document and after a gap in the feed. No connection, or a failed read, shows
 * nothing.
 */
export function useAgentSkill(connection: HcConnection | null, machine: string | undefined, name: string): SkillParts {
  const [read, setRead] = useState<Read>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const link = useMemo((): SkillLink | null => {
    if (connection === null) return null;
    return {
      call: connection.call.bind(connection),
      onDoc: (listener) => rosterFor(connection).onDoc(listener),
      onGap: (listener) => rosterFor(connection).onGap(listener),
    };
  }, [connection]);
  useEffect(() => {
    if (connection === null || link === null) return undefined;
    let live = true;
    const refresh = (): void => {
      void (async () => {
        const next = await readSkill(link, machine);
        if (live) setRead(next);
      })();
    };
    refresh();
    const roster = rosterFor(connection);
    const stops = [
      roster.subscribe(() => undefined),
      link.onDoc((on, doc) => (on === (machine ?? null) && doc === HOST_INFO_DOC ? refresh() : undefined)),
      link.onGap(refresh),
    ];
    return () => {
      live = false;
      for (const stop of stops) stop();
    };
  }, [connection, link, machine]);
  const install = useCallback(() => {
    if (link === null) return;
    setBusy(true);
    setError(undefined);
    void (async () => {
      try {
        // The host's own answer is the status after the install; its document is written again only after it.
        setRead({ skill: await requestSkill(link, machine) });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    })();
  }, [link, machine]);
  return connection === null ? NONE : skillParts(read, busy, error, install, name);
}

/** Hands a machine's row its skill parts; a component, so a list can give each row its own reads. */
export function AgentSkill({
  connection,
  machine,
  name,
  children,
}: {
  readonly connection: HcConnection | null;
  readonly machine: string | undefined;
  readonly name: string;
  readonly children: (parts: SkillParts) => ReactNode;
}) {
  return children(useAgentSkill(connection, machine, name));
}
