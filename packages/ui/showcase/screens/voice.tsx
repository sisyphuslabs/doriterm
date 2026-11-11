import { Mic } from "lucide-react";
import { IconButton, TabBar, VoiceStrip, type VoiceState } from "../../src/index.ts";
import { CLAUDE_LINES, TABS, VOICE_HEARD, VOICE_TRANSCRIPT } from "../data.ts";
import { BoardFrame, StateSection, TerminalCrop } from "./frames.tsx";
import { MobileTerminal } from "./mobile.tsx";
import { Sidebar, WorkspaceBody } from "./shell.tsx";

const LISTENING: VoiceState = { kind: "listening", seconds: 7, heard: true, text: VOICE_HEARD };
const STATES: readonly { readonly label: string; readonly state: VoiceState }[] = [
  {
    label: "First use: the browser's speech service hears nothing until Allow",
    state: { kind: "consent", device: true },
  },
  { label: "Listening", state: LISTENING },
  { label: "Transcribing", state: { kind: "transcribing", seconds: 7 } },
  {
    label: "Transcript ready: edit, then type it at the cursor",
    state: { kind: "ready", transcript: VOICE_TRANSCRIPT },
  },
  { label: "Error: microphone permission denied", state: { kind: "error", reason: "permission" } },
  { label: "Windows: microphone privacy is off", state: { kind: "error", reason: "mic-windows" } },
  { label: "Windows: no installed SAPI recognizer", state: { kind: "error", reason: "device-windows" } },
  { label: "Error: no speech heard", state: { kind: "error", reason: "no-speech" } },
  {
    label: "Unavailable: no speech recognition in this browser",
    state: { kind: "unavailable", why: "This browser has no speech recognition, so dictation is off here." },
  },
];

const strip = (state: VoiceState, className?: string) => (
  <VoiceStrip
    state={state}
    target="Claude Code"
    language="Korean (South Korea)"
    {...(className === undefined ? {} : { className })}
  />
);
const mic = (pressed: boolean) => (
  <IconButton label="Dictate into Claude Code" icon={<Mic />} size="md" pressed={pressed} />
);

/** #194: dictation into the terminal, from the phone header and the desktop tab bar, in every state. */
export function VoiceScreen() {
  return (
    <main className="min-h-dvh bg-background">
      <div data-density="coarse" className="h-[844px] md:hidden">
        <MobileTerminal action={mic(false)} />
      </div>
      <div data-density="coarse" className="md:hidden">
        {STATES.map((entry) => (
          <StateSection key={entry.label} label={entry.label}>
            <TerminalCrop lines={CLAUDE_LINES} dock={strip(entry.state, "pb-2")} className="h-72" />
          </StateSection>
        ))}
      </div>
      <div className="hidden h-[900px] md:flex">
        <Sidebar />
        <WorkspaceBody tabActions={mic(true)} claude={{ dock: strip(LISTENING, "pb-2") }} />
      </div>
      <div className="hidden grid-cols-2 gap-6 border-t border-border p-8 md:grid">
        <BoardFrame label="Idle: Dictate in the tab bar acts on the focused pane">
          <TerminalCrop lines={CLAUDE_LINES} header={<TabBar tabs={TABS} activeId="t1" trailing={mic(false)} />} />
        </BoardFrame>
        {STATES.map((entry) => (
          <BoardFrame key={entry.label} label={entry.label}>
            <TerminalCrop lines={CLAUDE_LINES} dock={strip(entry.state, "pb-2")} />
          </BoardFrame>
        ))}
      </div>
    </main>
  );
}
