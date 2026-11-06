import { ChevronLeft, Columns2, Ellipsis, Lock, Monitor, PanelLeft, Search, Settings } from "lucide-react";
import {
  AgentRow,
  Button,
  ExtraKeysBar,
  IconButton,
  Kbd,
  ScrollArea,
  SidebarSection,
  SpaceRow,
  StatusBar,
  StatusBarItem,
  StatusChip,
  TabBar,
  TerminalPreview,
  type TerminalLine,
} from "@doriface/ui";
import {
  AGENTS_DONE,
  AGENTS_IDLE,
  AGENTS_NEEDS_YOU,
  AGENTS_WORKING,
  OMO_LINES,
  CODEX_LINES,
  SPACES,
  TABS,
} from "./fixtures.ts";

function AgentLists() {
  return (
    <div className="flex flex-col gap-4 px-2 pb-3">
      <SidebarSection title="Spaces" count={SPACES.length}>
        {SPACES.map((space) => (
          <SpaceRow key={space.id} space={space} selected={space.id === "api"} />
        ))}
      </SidebarSection>
      <SidebarSection title="Needs you" count={AGENTS_NEEDS_YOU.length} tone="text-status-blocked-text">
        {AGENTS_NEEDS_YOU.map((agent) => (
          <AgentRow key={agent.id} agent={agent} selected compactBlocked />
        ))}
      </SidebarSection>
      <SidebarSection title="Done" count={AGENTS_DONE.length} tone="text-status-done-text">
        {AGENTS_DONE.map((agent) => (
          <AgentRow key={agent.id} agent={agent} />
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

function Pane({ title, lines }: { readonly title: string; readonly lines: readonly TerminalLine[] }) {
  return (
    <section
      aria-label={`${title} terminal`}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card"
    >
      <TerminalPreview lines={lines} cursor label={`${title} output`} className="flex-1" />
    </section>
  );
}

/** The desktop workspace: sidebar with spaces and agents, the tab bar, two split terminals and the status bar. */
export function DesktopView() {
  return (
    <div className="flex h-full overflow-hidden bg-background">
      <aside
        aria-label="Workspace"
        className="flex w-(--sidebar-width) shrink-0 flex-col border-r border-sidebar-border bg-sidebar"
      >
        <div className="flex h-11 shrink-0 items-center gap-1 pr-2 pl-3.5">
          <span className="flex-1 text-[0.84rem] font-semibold text-sidebar-foreground">doriterm</span>
          <IconButton label="Search" keys={["⌘", "P"]} icon={<Search />} />
          <IconButton label="Hide sidebar" keys={["⌘", "B"]} icon={<PanelLeft />} />
        </div>
        <ScrollArea slot="agents-list" className="flex-1">
          <AgentLists />
        </ScrollArea>
        <div className="flex shrink-0 flex-col gap-px border-t border-sidebar-border p-2">
          <Button variant="ghost" className="justify-start gap-2.5 px-2 text-sm">
            <Settings aria-hidden className="size-3.5" />
            Settings
          </Button>
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TabBar
          tabs={TABS}
          activeId="t1"
          newTabKeys={["⌘", "T"]}
          trailing={<IconButton label="Split" icon={<Columns2 />} pressed />}
        />
        <div className="flex min-h-0 flex-1 gap-2 p-2">
          <Pane title="OmO" lines={OMO_LINES} />
          <Pane title="Codex" lines={CODEX_LINES} />
        </div>
        <StatusBar
          start={
            <>
              <StatusBarItem icon={<Monitor aria-hidden />}>studio</StatusBarItem>
              <StatusBarItem icon={<Lock aria-hidden />}>relay, end-to-end encrypted</StatusBarItem>
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
    </div>
  );
}

/** The phone terminal: header with the agent's state, the terminal, and the key bar with ctrl latched. */
export function PhoneView() {
  return (
    <div data-density="coarse" data-insets="phone" className="relative flex h-full min-h-0 flex-col bg-card text-base">
      <header className="box-content flex h-12 shrink-0 items-center gap-1 border-b border-border bg-chrome px-1.5 pt-(--safe-top)">
        <IconButton label="Back to agents" icon={<ChevronLeft />} size="md" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="truncate text-base font-semibold text-foreground">OmO</h1>
          <StatusChip status="blocked" />
        </div>
        <IconButton label="Terminal actions" icon={<Ellipsis />} size="md" />
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <TerminalPreview lines={OMO_LINES} cursor label="OmO output" className="flex-1 text-[0.75rem]" />
      </div>
      <ExtraKeysBar latched={["ctrl"]} className="pb-[calc(var(--safe-bottom)+0.25rem)]" />
      <span
        aria-hidden
        className="absolute bottom-2 left-1/2 h-1.5 w-32 -translate-x-1/2 rounded-full bg-foreground/80"
      />
    </div>
  );
}
