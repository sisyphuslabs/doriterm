import {
  DirectionPad,
  ExtraKeysBar,
  Fingerprint,
  KeyboardButton,
  QrCode,
  SettingRow,
  Switch,
  TerminalPreview,
} from "../../src/index.ts";
import { sampleQrModules } from "../data.ts";
import { DEMO_KEYS } from "../keys.tsx";
import { ControlSpecimens } from "./control-specimens.tsx";
import { OverlaySpecimens } from "./overlay-specimens.tsx";
import { Section } from "./specimen.tsx";
import { StatusSpecimens } from "./status-specimens.tsx";
import { TerminalSettingsParts } from "./terminal-primitives.tsx";

/** ansi0 sits next to the background in dark themes, so the text sample starts at 1; PaletteEditor shows all 16. */
const ANSI_LINE = Array.from({ length: 15 }, (_, index) => ({
  text: ` ${(index + 1).toString().padStart(2, "0")} `,
  color: index + 1,
}));

export function PrimitivesScreen() {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 pb-40 md:px-8">
      <header>
        <h1 className="text-2xl font-semibold text-foreground">Doriterm primitives</h1>
        <p className="mt-1 text-base text-muted-foreground">
          Every component in packages/ui, in each state it ships with.
        </p>
      </header>
      <ControlSpecimens />
      <StatusSpecimens />
      <OverlaySpecimens />

      <Section title="Pairing and settings parts">
        <div className="grid items-start gap-6 md:grid-cols-3">
          <QrCode modules={sampleQrModules()} label="Sample QR code" className="w-40 border border-border p-1" />
          <Fingerprint label="Received" value="3fa94c0e91c4d8559e04b0f27f3bd2a08c4e6f19" mismatched={[2, 5]} />
          <div>
            <SettingRow
              title="Sounds"
              description="Play a sound when an agent needs you."
              control={<Switch aria-label="Sounds" defaultChecked />}
            />
          </div>
        </div>
      </Section>

      <Section title="Terminal">
        <div className="overflow-hidden rounded-lg border border-border">
          <TerminalPreview
            label="ANSI colours 1 to 15"
            lines={[
              ANSI_LINE.slice(0, 7),
              ANSI_LINE.slice(7),
              [{ text: "default foreground" }, { text: "  faint", dim: true }],
            ]}
            cursor
          />
          <ExtraKeysBar keys={DEMO_KEYS} latched={["ctrl"]} />
        </div>
        <div className="mt-3 flex items-end gap-6">
          <DirectionPad />
          <KeyboardButton />
        </div>
      </Section>

      <TerminalSettingsParts />
    </main>
  );
}
