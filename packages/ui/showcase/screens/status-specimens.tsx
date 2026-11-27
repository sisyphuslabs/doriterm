import {
  AGENT_MARKS,
  AgentFold,
  AgentMark,
  AgentRow,
  agentRowLead,
  Badge,
  Kbd,
  RowWithActions,
  SidebarSection,
  SpaceRow,
  StatusChip,
  StatusIndicator,
  TabBar,
  type AgentStatus,
} from "../../src/index.ts";
import { AGENTS_DONE, AGENTS_IDLE, AGENTS_NEEDS_YOU, AGENTS_TREE, AGENTS_WORKING, SPACES, TABS } from "../data.ts";
import { Cell, Row, Section } from "./specimen.tsx";

const STATUSES: readonly AgentStatus[] = ["working", "blocked", "done", "idle", "unknown"];
const noop = (): void => {};

/** The status grammar and the rows that carry it: agent rows, space rows and the tab strip. */
export function StatusSpecimens() {
  return (
    <>
      <Section title="Status">
        <Row>
          {STATUSES.map((status) => (
            <Cell key={status} label={status}>
              <span className="flex items-center gap-3">
                <StatusIndicator status={status} />
                <StatusChip status={status} />
              </span>
            </Cell>
          ))}
          <Cell label="badges">
            <span className="flex gap-2">
              <Badge>3</Badge>
              <Badge tone="blocked">1 needs you</Badge>
              <Badge tone="done">27 passed</Badge>
              <Badge tone="working">running</Badge>
            </span>
          </Cell>
          <Cell label="kbd">
            <Kbd keys={["⌘", "⇧", "P"]} />
          </Cell>
        </Row>
      </Section>

      <Section title="Agent marks">
        <Row>
          {Object.entries(AGENT_MARKS).map(([kind, entry]) => (
            <Cell key={kind} label={entry.label}>
              <AgentMark kind={kind} size={16} className="text-muted-foreground" />
            </Cell>
          ))}
        </Row>
      </Section>

      <Section title="AgentRow, SpaceRow, TabBar">
        <div className="grid gap-6 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-px rounded-lg bg-sidebar p-2">
            {[...AGENTS_NEEDS_YOU, ...AGENTS_DONE, ...AGENTS_WORKING, ...AGENTS_IDLE].map((agent) => (
              <AgentRow key={agent.id} agent={agent} selected={agent.id === "a2"} />
            ))}
            <AgentRow agent={{ id: "h", name: "Claude Code", detail: "hover", status: "working" }} data-force="hover" />
            <AgentRow agent={{ id: "f", name: "Codex", detail: "focus-visible", status: "idle" }} data-force="focus" />
            <AgentRow
              agent={{ id: "c", name: "Claude Code", detail: "compact blocked", status: "blocked" }}
              compactBlocked
            />
            <AgentRow
              agent={{
                id: "l",
                name: "Claude Code",
                detail: "a very long tab title that has to truncate without clipping",
                status: "done",
                machine: "build-box",
                age: "3d",
                pinned: true,
              }}
            />
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex min-w-0 flex-col gap-px rounded-lg bg-sidebar p-2">
              {SPACES.map((space) => (
                <SpaceRow key={space.id} space={space} selected={space.id === "api"} />
              ))}
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              <TabBar tabs={TABS} activeId="t1" newTabKeys={["⌘", "T"]} />
            </div>
            <div className="flex min-w-0 flex-col rounded-lg bg-sidebar p-2">
              <SidebarSection title="Agent tree" count={10}>
                {AGENTS_TREE.map(({ agent, parentName, fold }) => {
                  const row = (
                    <AgentRow agent={agent} disclosure {...(parentName === undefined ? {} : { parentName })} />
                  );
                  return fold === undefined ? (
                    <div key={agent.id}>{row}</div>
                  ) : (
                    <RowWithActions
                      key={agent.id}
                      row={row}
                      actions={null}
                      leading={
                        <AgentFold
                          name={agent.name}
                          folded={fold.folded}
                          count={fold.count}
                          blocked={fold.blocked}
                          urgency={fold.urgency}
                          onToggle={noop}
                          style={{ marginLeft: agentRowLead(agent.depth ?? 0, 3) }}
                        />
                      }
                    />
                  );
                })}
              </SidebarSection>
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}
