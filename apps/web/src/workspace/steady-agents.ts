import type { Agent } from "@doriface/ui";
import { useMemo, useRef } from "react";
import type { AgentGroup } from "./sidebar-model.ts";

/** Whether a sidebar row would draw the same for both: every field AgentRow shows (#2098). */
export const sameAgent = (a: Agent, b: Agent): boolean =>
  a.id === b.id &&
  a.name === b.name &&
  a.status === b.status &&
  a.detail === b.detail &&
  a.machine === b.machine &&
  a.age === b.age &&
  a.pinned === b.pinned &&
  a.icon === b.icon &&
  a.kind === b.kind &&
  (a.depth ?? 0) === (b.depth ?? 0) &&
  (a.descendants ?? 0) === (b.descendants ?? 0) &&
  a.urgency === b.urgency &&
  (a.guides ?? []).join() === (b.guides ?? []).join() &&
  a.todo?.done === b.todo?.done &&
  a.todo?.total === b.todo?.total;

/**
 * Each agent as the render before drew it while nothing it shows changed. The groups are built afresh on every terminal
 * event; without this every row of every agent drew again for one agent's title (#2086).
 */
export function useSteadyAgents(groups: readonly AgentGroup[]): readonly AgentGroup[] {
  const drawn = useRef(new Map<string, Agent>());
  return useMemo(() => {
    const before = drawn.current;
    const now = new Map<string, Agent>();
    const steady = groups.map((group) =>
      Object.assign({}, group, {
        agents: group.agents.map((agent) => {
          const kept = before.get(agent.id);
          const shown = kept !== undefined && sameAgent(kept, agent) ? kept : agent;
          now.set(agent.id, shown);
          return shown;
        }),
      }),
    );
    drawn.current = now;
    return steady;
  }, [groups]);
}
