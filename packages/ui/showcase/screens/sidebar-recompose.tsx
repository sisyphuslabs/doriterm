import { ArrowDownUp, Ellipsis, PanelLeft, PanelLeftOpen, Pin, Plus, Search, Settings } from "lucide-react";
import type { ReactNode } from "react";
import {
  AgentRow,
  IconButton,
  MachineHeader,
  Notice,
  RowWithActions,
  ScrollArea,
  SidebarFooter,
  SidebarFooterItem,
  SidebarSection,
  SpaceRow,
  cn,
  type Agent,
} from "../../src/index.ts";
import { MACHINES, ONE_MACHINE_SPACES, RECOMPOSE_GROUPS } from "../sidebar-data.ts";
import { WorkspaceBody } from "./shell.tsx";

interface Options {
  readonly machines: 1 | 3;
  readonly rail?: boolean;
  readonly hover?: string;
  readonly update?: boolean;
  readonly groups?: number;
}

/** Forces the hover state for a still capture: the actions shown, the meta they replace hidden. */
const HOVER = "[&>span]:visible [&_[data-row-meta]]:invisible [&>button]:bg-hover";

function Actions({ agent }: { readonly agent: Agent }) {
  return (
    <>
      <IconButton label={`Pin ${agent.name}`} icon={<Pin />} className="size-6" />
      <IconButton label={`More for ${agent.name}`} icon={<Ellipsis />} className="size-6" />
    </>
  );
}

function Agents({
  rail,
  hover,
  groups,
  heading = true,
}: Pick<Options, "rail" | "hover" | "groups"> & { readonly heading?: boolean }) {
  const hidden = rail === true ? "[&>header]:sr-only" : undefined;
  const list = (
    <div className="flex flex-col gap-3">
      {RECOMPOSE_GROUPS.slice(0, groups).map((group) => (
        <SidebarSection
          key={group.title}
          title={group.title}
          count={group.agents.length}
          {...(group.tone === undefined ? {} : { tone: group.tone })}
          {...(hidden === undefined ? {} : { className: hidden })}
        >
          {group.agents.map((agent) => {
            const row = (
              <AgentRow
                agent={agent}
                compactBlocked={group.compact === true}
                selected={agent.id === "a1"}
                rail={rail === true}
              />
            );
            return rail === true ? (
              <div key={agent.id}>{row}</div>
            ) : (
              <RowWithActions
                key={agent.id}
                row={row}
                actions={<Actions agent={agent} />}
                {...(hover === agent.id ? { className: HOVER } : {})}
              />
            );
          })}
        </SidebarSection>
      ))}
    </div>
  );
  if (!heading)
    return (
      <section aria-label="Agents" className="flex flex-col gap-px">
        <div className="flex justify-end px-2">
          <IconButton label="Sort agents" icon={<ArrowDownUp />} />
        </div>
        {list}
      </section>
    );
  return (
    <SidebarSection
      title="Agents"
      {...(rail === true
        ? { className: "[&>header]:sr-only" }
        : { action: <IconButton label="Sort agents" icon={<ArrowDownUp />} className="-mr-1" /> })}
    >
      {list}
    </SidebarSection>
  );
}

function Spaces({ machines, rail }: Pick<Options, "machines" | "rail">) {
  const r = rail === true;
  if (machines === 1)
    return (
      <SidebarSection
        title="Spaces"
        count={ONE_MACHINE_SPACES.length}
        {...(r
          ? { className: "[&>header]:sr-only" }
          : { action: <IconButton label="New space" icon={<Plus />} className="-mr-1" /> })}
      >
        {ONE_MACHINE_SPACES.map((space) => (
          <SpaceRow key={space.id} space={space} rail={r} />
        ))}
      </SidebarSection>
    );
  return (
    <SidebarSection title="Spaces" {...(r ? { className: "[&>header]:sr-only" } : {})}>
      <div className="flex flex-col gap-2">
        {MACHINES.map((machine) => (
          <section key={machine.name} aria-label={machine.name} className="flex flex-col gap-px">
            <MachineHeader
              name={machine.name}
              local={machine.local}
              state={machine.state}
              alarm={machine.alarm === true}
              // The sum of the counts on the rows under it, also while the machine is offline.
              tabs={machine.spaces.reduce((sum, space) => sum + space.tabs, 0)}
              connected={machine.state !== "offline"}
              rail={r}
              onToggle={() => {}}
              onNewSpace={() => {}}
              {...(machine.state === "offline" ? {} : { onOpen: () => {} })}
            />
            {machine.spaces.map((space) => (
              <SpaceRow key={space.id} space={space} rail={r} hideMachine />
            ))}
            {machine.alarm === true && !r ? (
              <Notice tone="warning" className="mx-1 mt-1" title="gpu-box is offline">
                It stopped answering 2 hours ago.
              </Notice>
            ) : null}
          </section>
        ))}
      </div>
    </SidebarSection>
  );
}

export function RecomposedSidebar({ machines, rail = false, hover, update = false, groups = 6 }: Options) {
  return (
    <aside
      aria-label="Workspace"
      data-rail={rail || undefined}
      className={cn(
        "relative flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar",
        rail ? "w-(--sidebar-rail-width)" : "w-(--sidebar-width)",
      )}
    >
      <div className={cn("flex h-11 shrink-0 items-center gap-1", rail ? "justify-center" : "pr-2 pl-3.5")}>
        {rail ? null : (
          <>
            <span className="flex-1 text-sm font-semibold text-sidebar-foreground">Doriterm</span>
            <IconButton label="Command palette" keys={["⌘", "⇧", "P"]} icon={<Search />} />
            <IconButton label="Hide sidebar" keys={["⌘", "B"]} icon={<PanelLeft />} />
          </>
        )}
      </div>
      <ScrollArea slot="agents-list" className="flex-1">
        <div className="flex flex-col gap-4 px-2 pb-3">
          <Agents rail={rail} groups={groups} {...(hover === undefined ? {} : { hover })} />
          <Spaces machines={machines} rail={rail} />
        </div>
      </ScrollArea>
      <SidebarFooter rail={rail}>
        {rail ? <SidebarFooterItem rail icon={<PanelLeftOpen aria-hidden />} label="Expand sidebar" /> : null}
        <SidebarFooterItem rail={rail} icon={<Plus aria-hidden />} label="Add machine" />
        <SidebarFooterItem
          rail={rail}
          icon={<Settings aria-hidden />}
          label="Settings"
          {...(update ? { dot: "update ready" } : {})}
        />
      </SidebarFooter>
      <div aria-hidden className="absolute inset-y-0 -right-px w-px" />
    </aside>
  );
}

function Frame({
  title,
  wide = false,
  children,
}: {
  readonly title: string;
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <figure className={cn("flex min-w-0 flex-col gap-2 has-[[data-rail]]:w-28", wide && "w-full")}>
      <figcaption className="text-xs font-medium text-muted-foreground">{title}</figcaption>
      <div className="flex h-[680px] overflow-hidden rounded-xl border border-border bg-background">{children}</div>
    </figure>
  );
}

/** #206: the recomposed sidebar in every state the issue names, side by side, then in the shell. */
/** The phone's first screen: the same lists at full width with touch sizes; no hover, so no hover actions. */
function PhoneAgents({ machines }: Pick<Options, "machines">) {
  return (
    <div data-density="coarse" className="flex h-full w-full flex-col bg-sidebar">
      <header className="flex h-12 shrink-0 items-center gap-1 px-4">
        <h1 className="flex-1 text-xl font-semibold text-foreground">Agents</h1>
        <IconButton label="Command palette" icon={<Search />} size="md" />
        <IconButton label="Settings" icon={<Settings />} size="md" />
      </header>
      <ScrollArea slot="agents-list" className="flex-1">
        <div className="flex flex-col gap-4 px-2 pb-3">
          <Agents groups={4} heading={false} />
          <Spaces machines={machines} />
        </div>
      </ScrollArea>
    </div>
  );
}

export function SidebarRecomposeScreen() {
  return (
    <div className="flex min-h-dvh flex-col gap-6 bg-canvas p-6 max-md:p-3">
      <div className="flex flex-col gap-6 md:hidden">
        <Frame title="Phone: one machine" wide>
          <PhoneAgents machines={1} />
        </Frame>
        <Frame title="Phone: three machines" wide>
          <PhoneAgents machines={3} />
        </Frame>
      </div>
      <div className="flex flex-wrap gap-6 max-md:hidden">
        <Frame title="One machine">
          <RecomposedSidebar machines={1} groups={5} />
        </Frame>
        <Frame title="Three machines">
          <RecomposedSidebar machines={3} groups={3} />
        </Frame>
        <Frame title="Agents in every state">
          <RecomposedSidebar machines={1} />
        </Frame>
        <Frame title="Hover: pin and more only">
          <RecomposedSidebar machines={3} hover="a3" groups={3} />
        </Frame>
        <Frame title="Update ready">
          <RecomposedSidebar machines={1} update groups={3} />
        </Frame>
        <Frame title="Icon rail">
          <RecomposedSidebar machines={3} rail update />
        </Frame>
      </div>
      <div className="contents max-md:hidden">
        <Frame title="In the shell: three machines" wide>
          <RecomposedSidebar machines={3} groups={4} />
          <div className="hidden min-w-0 flex-1 md:flex">
            <WorkspaceBody />
          </div>
        </Frame>
      </div>
    </div>
  );
}
