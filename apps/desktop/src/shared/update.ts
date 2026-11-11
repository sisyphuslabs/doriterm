/** The desktop app's update channel and what its updater is doing, as the main process tells the page (#1969). */

export const UPDATE_CHANNELS = ["stable", "beta"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const isUpdateChannel = (value: unknown): value is UpdateChannel =>
  UPDATE_CHANNELS.some((channel) => channel === value);

/** Why an update did not arrive, each with its own line in Settings rather than only a log entry. */
export type UpdateFailure = "check" | "download" | "stalled" | "below-floor";

export type UpdateStatus =
  | { readonly state: "idle" }
  | { readonly state: "checking" }
  | { readonly state: "current" }
  | { readonly state: "downloading"; readonly version: string; readonly percent: number }
  | { readonly state: "ready"; readonly version: string }
  | { readonly state: "failed"; readonly reason: UpdateFailure; readonly message: string };

const STATES = new Set(["idle", "checking", "current", "downloading", "ready", "failed"]);
const REASONS = new Set(["check", "download", "stalled", "below-floor"]);

export function isUpdateStatus(value: unknown): value is UpdateStatus {
  if (typeof value !== "object" || value === null) return false;
  const field = (name: string): unknown => Reflect.get(value, name);
  const state = field("state");
  if (typeof state !== "string" || !STATES.has(state)) return false;
  if (state === "downloading") return typeof field("version") === "string" && typeof field("percent") === "number";
  if (state === "ready") return typeof field("version") === "string";
  if (state === "failed") return REASONS.has(String(field("reason"))) && typeof field("message") === "string";
  return true;
}
