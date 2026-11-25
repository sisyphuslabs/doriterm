import { Button, Menu, MenuItem, Notice, SegmentedControl, SettingRow } from "@doriface/ui";
import { Check, ChevronDown } from "lucide-react";
import { desktopDictation } from "../voice/desktop-recognizer.ts";
import { type Engine, languageName, VOICE_LANGUAGES } from "../voice/voice-settings.ts";
import { useVoiceSettings, voiceStore } from "../voice/voice-store.ts";
import { type VoiceBlocked, voiceBlocked } from "./voice-support.ts";
import { SonioxSettings } from "./soniox-settings.tsx";

const ENGINES = [
  { value: "ask", label: "Ask first" },
  { value: "device", label: "On device" },
  { value: "service", label: "Service" },
  { value: "soniox", label: "Soniox" },
] as const;

const ENGINE_NOTE: Readonly<Record<Engine, string>> = {
  ask: "The first dictation asks before any audio goes to the browser's speech service, which may run outside this device.",
  device: "Only the browser's on-device recognizer listens; the audio never leaves this device.",
  service: "The browser sends the audio to its speech service, which may run outside this device.",
  soniox:
    "Soniox turns speech into text in real time. Audio goes from this device straight to Soniox, with the key from your mesh vault.",
};

const BLOCKED: Readonly<Record<VoiceBlocked, string>> = {
  unsupported:
    "This browser has no speech recognition, so the mic cannot listen. Type instead, or open Doriterm in Chrome or Safari.",
  insecure: "The browser only listens on a secure (https) page. Open Doriterm over https to dictate, or type instead.",
  desktop: "The desktop app can't dictate yet. For dictation, use Doriterm in Chrome or Safari; here, type instead.",
  "desktop-windows":
    "The Windows app can't dictate yet. For dictation, use Doriterm in Chrome or Edge; here, type instead.",
};

/** Dictation: where it sends the audio, and the language and way it is recognized; nothing here keeps any audio. */
export function VoiceSection() {
  const settings = useVoiceSettings();
  const blocked = voiceBlocked(window);
  const native = blocked === null ? desktopDictation() : null;
  const browser = navigator.language;
  const name = (tag: string) => (tag === "" ? `Browser language: ${languageName(browser)}` : languageName(tag));
  const listed = VOICE_LANGUAGES.includes(settings.language) || settings.language === "" ? [] : [settings.language];
  const choices = ["", ...VOICE_LANGUAGES, ...listed];
  const language = (
    <Menu
      align="end"
      trigger={
        <Button
          variant="secondary"
          aria-label={`Language, ${name(settings.language)}`}
          // A long language name gives way inside the row instead of pushing the button past the screen's edge.
          className="max-w-full min-w-0 justify-between [&>span]:max-w-full [&>span]:min-w-0"
        >
          <span title={name(settings.language)} className="truncate">
            {name(settings.language)}
          </span>
          <ChevronDown aria-hidden />
        </Button>
      }
    >
      {choices.map((tag) => (
        <MenuItem
          key={tag}
          icon={<Check aria-hidden className={tag === settings.language ? "" : "invisible"} />}
          onClick={() => voiceStore.update({ language: tag })}
        >
          {name(tag)}
        </MenuItem>
      ))}
    </Menu>
  );
  return (
    <div className="flex flex-col gap-4">
      <p data-voice-intro className="text-prose text-pretty text-muted-foreground">
        Dictation types what you say into the focused terminal, at the cursor, without pressing Return. Start it with
        the mic above the terminal, beside its title, then speak.
      </p>
      {blocked === "insecure" ? (
        <Notice tone="info" title="Dictation isn't available here">
          {BLOCKED[blocked]}
        </Notice>
      ) : (
        <>
          <div className="flex flex-col">
            {blocked === null || settings.engine === "soniox" ? (
              <SettingRow
                title="Language"
                description="Speech recognition takes one language at a time."
                control={language}
              />
            ) : null}
            {native !== null ? (
              <p data-voice-on-mac className="pt-3 text-prose text-pretty text-muted-foreground">
                {native.unavailableReason === "device-windows"
                  ? "Windows SAPI recognizes speech on this computer; the audio never leaves it."
                  : "macOS recognizes speech on this Mac; the audio never leaves it."}
              </p>
            ) : null}
            <SettingRow
              title="Speech recognition"
              description={ENGINE_NOTE[settings.engine]}
              control={
                <SegmentedControl<Engine>
                  label="Speech recognition"
                  compact
                  options={ENGINES}
                  value={settings.engine}
                  onValueChange={(next) => voiceStore.update({ engine: next })}
                />
              }
            />
            {settings.engine === "soniox" ? <SonioxSettings /> : null}
          </div>
          {blocked === null ? null : (
            <Notice tone="info" title="Dictation isn't available here">
              {BLOCKED[blocked]}
            </Notice>
          )}
        </>
      )}
    </div>
  );
}
