/**
 * What a notice is about (#1908): enough for a notification read at a glance on a lock screen to say which agent,
 * where it runs and what it asks. The host takes it from the terminal as the notice is made; it travels only over the
 * E2EE push stream (`PushHostLine` `notice`) and the desktop shell's IPC, never in a push payload, which stays
 * `{v,n,k,h}`. Every text is scrubbed (no home path, no token-shaped run, no control character) and capped.
 */
import type { Status, Terminal } from "./__generated__/hc-api.ts";
import type { ScreenPrompt } from "./approval-rows.ts";
import { isJsonObject } from "./json.ts";
import type { NoticeEvent } from "./push.ts";

export interface NoticeContext {
  /** The terminal's title as the app shows it: its rename, its name, the program's own title, else its program. */
  readonly title?: string;
  /** Its space: the `space` label, else the last segment of its working directory. */
  readonly space?: string;
  /** The added machine it runs on, by the name it was added under; absent on the host's own core. */
  readonly machine?: string;
  /** What it asks or said: a permission's agent, verb and command; a question's own line; else the status message. */
  readonly asks?: string;
  /** How long ago the notice was raised, on the clock of the side that answers; absent when it is not known. */
  readonly ageMs?: number;
}

/** The hc label a rename writes (apps/web session-actions): the title a person gave the terminal. */
export const TITLE_LABEL = "herdr.name";
/** The hc label that names a terminal's space (apps/web workspace model). */
export const SPACE_LABEL = "space";
/** A name the page gives a terminal only so its attach can follow the run (apps/web opening-attach): no title. */
const OPENING_NAME_PREFIX = "opened-";

/** No field of a context is longer than this, on the wire or in a notification. */
export const MAX_NOTICE_TEXT = 200;
/** A notification's title line and body, at most: a lock screen shows about one line of each before cutting. */
export const MAX_TITLE_CHARS = 72;
export const MAX_BODY_CHARS = 160;
/** Each part of the title line (the terminal, its space, its machine) is cut to this many characters. */
const MAX_TITLE_PART = 32;
/** Ages below a minute are not shown: a notice that just arrived needs no clock. */
const AGE_SHOWN_FROM_MS = 60_000;

export const ELLIPSIS = "\u2026";

/**
 * Keeps the start and the end of a text that is too long, with an ellipsis between: the start identifies, the end
 * often carries the ask. Counted in code points, so a cut never splits a character.
 */
export function truncateMiddle(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max <= 1) return ELLIPSIS;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${chars.slice(0, head).join("")}${ELLIPSIS}${tail === 0 ? "" : chars.slice(chars.length - tail).join("")}`;
}

/** Home directories, on any platform, as a notification may not name a user: `/Users/me/x` and `C:\Users\me\x` read `~/x`. */
const HOME_PATH = /(?:\/(?:Users|home)\/[^\s/\\]+|[A-Za-z]:\\Users\\[^\s/\\]+)(?=[\s/\\]|$)/g;
/**
 * Runs that look like credentials: known key prefixes (OpenAI, GitHub, Slack, AWS, Google), bearer tokens, JWTs, and
 * any long opaque run of token characters. A command that carries one still names what it does; the secret reads `…`.
 */
const SECRET_RUNS = [
  /\b(?:sk|rk|pk)-[\w-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[\w-]{20,}/g,
  /\bxox[abeprs]-[\w-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[\w-]{30,}/g,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
  /\b(Bearer|Basic|token|secret|password|passwd|api[_-]?key)(\s*[:=]\s*|\s+)[\w.+/=-]+/gi,
  /(?<![\w/.-])[A-Za-z0-9_+=-]{32,}(?![\w/.-])/g,
] as const;

/** One line of text fit for an OS notification: no control characters, no home path, no token-shaped run, capped. */
export function scrubNoticeText(text: string, max: number = MAX_NOTICE_TEXT): string {
  let clean = text
    // oxlint-disable-next-line no-control-regex -- an escape sequence is exactly what a notification may not carry
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // oxlint-disable-next-line no-control-regex -- as are the control characters themselves
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  clean = clean.replace(HOME_PATH, "~");
  for (const run of SECRET_RUNS) {
    clean = clean.replace(run, (_match, word?: string, join?: string) =>
      typeof word === "string" && typeof join === "string" ? `${word}${join}${ELLIPSIS}` : ELLIPSIS,
    );
  }
  return truncateMiddle(clean, max);
}

const present = (text: string | null | undefined): text is string => text !== undefined && text !== null && text !== "";

function basename(path: string): string {
  return path.split(/[/\\]/).findLast((part) => part !== "") ?? path;
}

/** The terminal's title as the app's strip and rows show it (apps/web workspace model `terminalTitle`), paths as names. */
function titleOf(terminal: Terminal): string | undefined {
  const renamed = terminal.labels[TITLE_LABEL];
  if (present(renamed)) return renamed;
  const named =
    terminal.name?.startsWith(OPENING_NAME_PREFIX) === true ? terminal.title : (terminal.name ?? terminal.title);
  if (present(named)) return named;
  const program = terminal.foreground?.name ?? terminal.argv[0];
  return present(program) ? basename(program) : terminal.address;
}

function spaceOf(terminal: Terminal): string | undefined {
  const labelled = terminal.labels[SPACE_LABEL];
  if (present(labelled)) return labelled;
  const dir = terminal.foreground?.cwd ?? terminal.cwd;
  return present(dir) ? basename(dir) : undefined;
}

/** What the agent asks, in its own words: a permission as a sentence, a question as its line, else what its status says. */
function asksOf(prompt: ScreenPrompt | undefined, status: Status | null | undefined): string | undefined {
  if (prompt !== undefined) {
    if (prompt.kind === "question") return present(prompt.question) ? prompt.question : prompt.command;
    const sentence = [prompt.agent, prompt.asks, prompt.command].filter(present).join(" ");
    if (sentence !== "") return sentence;
    if (present(prompt.question)) return prompt.question;
  }
  return present(status?.msg) ? status.msg : present(status?.title) ? status.title : undefined;
}

export interface NoticeSource {
  /** The terminal's record as it stood; absent when the core could not be asked. */
  readonly terminal?: Terminal | undefined;
  /** The status that raised the notice, from the event itself: there even when the record is not. */
  readonly status?: Status | null | undefined;
  readonly machine?: string | undefined;
  /** The prompt read off the live screen for a permission or a question, when it was one the readers know. */
  readonly prompt?: ScreenPrompt | undefined;
}

const clean = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  const scrubbed = scrubNoticeText(text);
  return scrubbed === "" ? undefined : scrubbed;
};

/** A notice's context from what the host (or the desktop app) knows; a field it does not know is left out, never guessed. */
export function noticeContextOf(source: NoticeSource): NoticeContext {
  const terminal = source.terminal;
  const status = terminal?.status ?? source.status;
  const context: { -readonly [K in keyof NoticeContext]: NoticeContext[K] } = {};
  const title = clean(terminal === undefined ? undefined : titleOf(terminal));
  const space = clean(terminal === undefined ? undefined : spaceOf(terminal));
  const machine = clean(source.machine);
  const asks = clean(asksOf(source.prompt, status));
  if (title !== undefined) context.title = title;
  if (space !== undefined) context.space = space;
  if (machine !== undefined) context.machine = machine;
  if (asks !== undefined) context.asks = asks;
  return context;
}

const TEXT_KEYS = ["title", "space", "machine", "asks"] as const;

/**
 * A context as it arrives over the push stream or IPC: an object whose known fields are well-formed. A field that is
 * not a string, is empty or is too long is dropped, not guessed; anything that is no object is no context.
 */
export function parseNoticeContext(value: unknown): NoticeContext | undefined {
  if (!isJsonObject(value)) return undefined;
  const context: { -readonly [K in keyof NoticeContext]: NoticeContext[K] } = {};
  for (const key of TEXT_KEYS) {
    const text = value[key];
    if (typeof text === "string" && text !== "" && Array.from(text).length <= MAX_NOTICE_TEXT) {
      context[key] = scrubNoticeText(text);
    }
  }
  const age = value["ageMs"];
  if (typeof age === "number" && Number.isFinite(age) && age >= 0) context.ageMs = Math.floor(age);
  return context;
}

/** "2 min", "3 h", "2 d": how long ago, for a notice that did not arrive at once. */
export function formatNoticeAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

export interface NoticeText {
  readonly title: string;
  readonly body: string;
}

/** The sentence a notice shows when nothing is known about it: what every notice said before #1908. */
export const PLAIN_BODY: Readonly<Record<NoticeEvent, string>> = {
  input: "An agent is waiting for your input.",
  permission: "An agent is asking for permission.",
  done: "An agent finished its turn.",
  error: "An agent stopped with an error.",
};

/** The state in two or three words, which the body opens with once the title names the agent. */
const PHRASE: Readonly<Record<NoticeEvent, string>> = {
  input: "Needs your input",
  permission: "Needs permission",
  done: "Finished",
  error: "Error",
};

const SEPARATOR = " \u00b7 ";

/**
 * A notification's two lines. Title: the terminal, its space and its machine, each cut in the middle, the parts
 * dropped from the right when the line is still too long. Body: the state, then what the agent asks, then how long
 * ago when that is a minute or more; the ask is cut in the middle so the body fits. A context with nothing in it,
 * or none, shows the app's name and the plain sentence: that is the honest text when the host could not be asked.
 */
export function noticeText(kind: NoticeEvent, context: NoticeContext | undefined): NoticeText {
  const where = [context?.title, context?.space, context?.machine].filter(present);
  const unique = where.filter((part, index) => where.indexOf(part) === index);
  const title = titleLine(unique);
  if (title === undefined && context?.asks === undefined) return { title: "Doriterm", body: PLAIN_BODY[kind] };
  const age =
    context?.ageMs !== undefined && context.ageMs >= AGE_SHOWN_FROM_MS
      ? `${formatNoticeAge(context.ageMs)} ago`
      : undefined;
  const suffix = age === undefined ? "" : `${SEPARATOR}${age}`;
  const lead = `${PHRASE[kind]}: `;
  const room = MAX_BODY_CHARS - Array.from(lead).length - Array.from(suffix).length;
  const asks = context?.asks === undefined ? undefined : truncateMiddle(context.asks, Math.max(room, 8));
  const body = `${asks === undefined ? PHRASE[kind] : `${lead}${asks}`}${suffix}`;
  return { title: title ?? "Doriterm", body };
}

/** The title line from its parts: each cut to MAX_TITLE_PART, then parts dropped from the right until it fits. */
function titleLine(parts: readonly string[]): string | undefined {
  const cut = parts.map((part) => truncateMiddle(part, MAX_TITLE_PART));
  for (let keep = cut.length; keep > 0; keep--) {
    const line = cut.slice(0, keep).join(SEPARATOR);
    if (Array.from(line).length <= MAX_TITLE_CHARS) return line;
  }
  return cut[0] === undefined ? undefined : truncateMiddle(cut[0], MAX_TITLE_CHARS);
}
