import type { Agent, Space } from "../src/index.ts";

/** Agents in every state the sidebar shows, as the app groups them (#206). */
export const RECOMPOSE_GROUPS: readonly {
  title: string;
  tone?: string;
  compact?: boolean;
  agents: readonly Agent[];
}[] = [
  {
    title: "Pinned",
    agents: [{ id: "p1", name: "Codex", detail: "release train", status: "working", age: "3m", pinned: true }],
  },
  {
    title: "Needs you",
    tone: "text-status-blocked-text",
    compact: true,
    agents: [{ id: "a1", name: "Claude Code", detail: "approve migration", status: "blocked", age: "2m" }],
  },
  {
    title: "Working",
    tone: "text-status-working-text",
    agents: [
      { id: "a3", name: "Claude Code", detail: "web-client", status: "working", age: "<1m" },
      { id: "a4", name: "Codex", detail: "terraform plan", status: "working", machine: "build-box", age: "12m" },
    ],
  },
  { title: "Idle", agents: [{ id: "a5", name: "shell", detail: "release-notes", status: "idle", age: "1h" }] },
  {
    title: "Done",
    tone: "text-status-done-text",
    agents: [{ id: "a2", name: "Codex", detail: "file sync tests", status: "done", age: "6m" }],
  },
  {
    title: "Offline",
    agents: [{ id: "a6", name: "train", detail: "epoch 14", status: "unknown", machine: "gpu-box", age: "2h" }],
  },
];

export const ONE_MACHINE_SPACES: readonly Space[] = [
  { id: "api", name: "api-server", tabs: 3, attention: "blocked", color: "teal" },
  { id: "web", name: "web-client", tabs: 2, attention: "working", color: "orange" },
  { id: "notes", name: "release-notes", tabs: 1, attention: "idle", color: "violet" },
];

export const MACHINES: readonly {
  name: string;
  local: boolean;
  state: string;
  alarm?: boolean;
  spaces: readonly Space[];
}[] = [
  { name: "studio", local: true, state: "this machine", spaces: ONE_MACHINE_SPACES },
  {
    name: "build-box",
    local: false,
    state: "connected",
    spaces: [{ id: "infra", name: "infra", tabs: 2, attention: "working", color: "blue" }],
  },
  {
    name: "gpu-box",
    local: false,
    state: "offline",
    alarm: true,
    spaces: [{ id: "train", name: "trainer", tabs: 1, color: "green" }],
  },
];
