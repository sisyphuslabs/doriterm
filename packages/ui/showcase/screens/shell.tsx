import { Columns2, Ellipsis, Folder, Monitor, PanelLeft, Search, Settings } from "lucide-react";
import type { ReactNode } from "react";
import {
  AgentRow,
  Button,
  IconButton,
  Kbd,
  ScrollArea,
  SidebarSection,
  SpaceRow,
  StatusBar,
  StatusBarItem,
  TabBar,
  TerminalPreview,
  cn,
  type TerminalLine,
} from "../../src/index.ts";
import {
  AGENTS_DONE,
  AGENTS_IDLE,
  AGENTS_NEEDS_YOU,
  AGENTS_WORKING,
  CLAUDE_LINES,
  CODEX_LINES,
  SPACES,
  TABS,
} from "../data.ts";

/** Spaces and the agent sections, shared by the desktop sidebar and the phone's first screen. */
export function AgentLists({
  selected,
  agentsFirst = false,
}: {
  readonly selected?: string;
  readonly agentsFirst?: boolean;
}) {
  const spaces = (
    <SidebarSection title="Spaces" count={SPACES.length} className={agentsFirst ? "order-last" : ""}>
      {SPACES.map((space) => (
        <SpaceRow key={space.id} space={space} selected={!agentsFirst && space.id === "api"} />
      ))}
    </SidebarSection>
  );
  return (
    <div className="flex flex-col gap-4 px-2 pb-3">
      {spaces}
      <SidebarSection title="Needs you" count={AGENTS_NEEDS_YOU.length} tone="text-status-blocked-text">
        {AGENTS_NEEDS_YOU.map((agent) => (
          <AgentRow key={agent.id} agent={agent} selected={agent.id === selected} compactBlocked />
        ))}
      </SidebarSection>
      <SidebarSection title="Done" count={AGENTS_DONE.length} tone="text-status-done-text">
        {AGENTS_DONE.map((agent) => (
          <AgentRow key={agent.id} agent={agent} selected={agent.id === selected} />
        ))}
      </SidebarSection>
      <SidebarSection title="Working" count={AGENTS_WORKING.length} tone="text-status-working-text">
        {AGENTS_WORKING.map((agent) => (
          <AgentRow key={agent.id} agent={agent} />
        ))}
      </SidebarSection>
      <SidebarSection title="Idle" count={AGENTS_IDLE.length}>
        {AGENTS_IDLE.map((agent) => (
          <AgentRow key={agent.id} agent={agent} />
        ))}
      </SidebarSection>
    </div>
  );
}

/** What a mockup pins over a pane's terminal (`overlay`) or docks under it (`dock`). */
export interface PaneExtras {
  readonly overlay?: ReactNode;
  readonly dock?: ReactNode;
}

/** A terminal card with no title bar, as in the app: its tab names it and the status bar says where it runs (#108). */
function Pane(props: { readonly title: string; readonly lines: readonly TerminalLine[] } & PaneExtras) {
  return (
    <section
      aria-label={`${props.title} terminal`}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card"
    >
      <TerminalPreview lines={props.lines} cursor label={`${props.title} output`} className="flex-1" />
      {props.dock}
      {props.overlay === undefined ? null : (
        <div className="absolute inset-x-2 top-2 mx-auto max-w-[40rem]">{props.overlay}</div>
      )}
    </section>
  );
}

export function Sidebar() {
  return (
    <aside
      aria-label="Workspace"
      className="hidden w-(--sidebar-width) shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 pr-2 pl-3.5">
        <span className="flex-1 text-[0.84rem] font-semibold text-sidebar-foreground">doriface</span>
        <IconButton label="Search" keys={["⌘", "P"]} icon={<Search />} />
        <IconButton label="Hide sidebar" keys={["⌘", "B"]} icon={<PanelLeft />} />
      </div>
      <ScrollArea slot="agents-list" className="flex-1">
        <AgentLists selected="a1" />
      </ScrollArea>
      <div className="flex shrink-0 flex-col gap-px border-t border-sidebar-border p-2">
        <Button variant="ghost" className="justify-start gap-2.5 px-2 text-sm">
          <Settings aria-hidden className="size-3.5" />
          Settings
        </Button>
      </div>
    </aside>
  );
}

export function WorkspaceBody({
  claude = {},
  claudeLines = CLAUDE_LINES,
  tabActions,
}: {
  readonly claude?: PaneExtras;
  readonly claudeLines?: readonly TerminalLine[];
  readonly tabActions?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TabBar
        tabs={TABS}
        activeId="t1"
        newTabKeys={["⌘", "T"]}
        trailing={
          <>
            {tabActions}
            <IconButton label="Session actions for Claude Code" icon={<Ellipsis />} className="size-6" />
            <IconButton label="Split" icon={<Columns2 />} pressed />
          </>
        }
      />
      <div className="flex min-h-0 flex-1 gap-2 p-2">
        <Pane title="Claude Code" lines={claudeLines} {...claude} />
        <Pane title="Codex" lines={CODEX_LINES} />
      </div>
      <StatusBar
        start={
          <>
            <StatusBarItem icon={<Monitor aria-hidden />}>studio</StatusBarItem>
            <StatusBarItem icon={<Folder aria-hidden />}>doriface</StatusBarItem>
            <StatusBarItem>
              5 terminals <span className="text-status-blocked-text">· 1 needs you</span>
            </StatusBarItem>
          </>
        }
        end={
          <StatusBarItem>
            <Kbd keys={["⌘", "⇧", "P"]} /> Commands
          </StatusBarItem>
        }
      />
    </div>
  );
}

/** Phone and narrow-window navigation root: the same lists as the sidebar, full width. */
export function CompactHome({ className }: { readonly className?: string }) {
  return (
    <div className={cn("flex h-full min-h-0 min-w-0 flex-col bg-sidebar", className)}>
      <header className="box-content flex h-12 shrink-0 items-center gap-1 px-4 pt-(--safe-top)">
        <h1 className="flex-1 text-xl font-semibold text-foreground">Agents</h1>
        <IconButton label="Search" icon={<Search />} size="md" />
        <IconButton label="Settings" icon={<Settings />} size="md" />
      </header>
      <ScrollArea slot="agents-list" className="flex-1">
        <AgentLists agentsFirst />
      </ScrollArea>
      <StatusBar
        start={<StatusBarItem icon={<Monitor aria-hidden />}>studio · relay</StatusBarItem>}
        className="h-[calc(var(--statusbar-height)+var(--safe-bottom))] pb-(--safe-bottom)"
      />
    </div>
  );
}

export function ShellFrame({ children }: { readonly children?: ReactNode }) {
  return (
    <div className="relative flex h-dvh overflow-hidden bg-background">
      <Sidebar />
      <div className="hidden min-w-0 flex-1 md:flex">
        <WorkspaceBody />
      </div>
      <CompactHome className="flex-1 md:hidden" />
      {children}
    </div>
  );
}

export function ShellScreen() {
  return <ShellFrame />;
}
