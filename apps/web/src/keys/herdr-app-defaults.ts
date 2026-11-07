import { readFileSync } from "node:fs";
import { normalizeTrigger, type Platform } from "./trigger.ts";

/** The herdr-app commit `herdr-app/keys.json` and `herdr-app/keys.macos.json` were copied from (herdr-app/SOURCE.md). */
export const HERDR_APP_COMMIT = "cfcf836404f932817f10f88455c33e33c94fd1df";

/** herdr-app's file per platform: `keys.macos.json` on macOS, `keys.json` everywhere else. */
export const HERDR_APP_FILE: Readonly<Record<Platform, string>> = { mac: "keys.macos.json", other: "keys.json" };

/** One default binding: herdr-app's own spelling of the chord, doriface's trigger for it, and the action. */
export interface HerdrBinding {
  readonly chord: string;
  readonly trigger: string;
  readonly action: string;
}

function isSections(value: unknown): value is Record<string, Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((section) => typeof section === "object" && section !== null)
  );
}

/**
 * herdr-app's default bindings for a platform, read from the vendored file, every section in file order. Chords that
 * spell one key two ways (`ctrl-?` and `ctrl-shift-/`) are both listed, under the same trigger. Test and build-script
 * use only: the app never loads these files.
 */
export function herdrAppDefaults(platform: Platform): readonly HerdrBinding[] {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL(`./herdr-app/${HERDR_APP_FILE[platform]}`, import.meta.url), "utf8"),
  );
  if (!isSections(parsed)) throw new Error(`herdr-app/${HERDR_APP_FILE[platform]} is not a keys file`);
  return Object.values(parsed).flatMap((section) =>
    Object.entries(section).map(([chord, action]) => {
      const trigger = normalizeTrigger(chord, true);
      if (trigger === null || typeof action !== "string") throw new Error(`herdr-app binding not understood: ${chord}`);
      return { chord, trigger, action };
    }),
  );
}

export const HERDR_APP_MAC: readonly string[] = [...new Set(herdrAppDefaults("mac").map((entry) => entry.trigger))];

export const HERDR_APP_OTHER: readonly string[] = [...new Set(herdrAppDefaults("other").map((entry) => entry.trigger))];
