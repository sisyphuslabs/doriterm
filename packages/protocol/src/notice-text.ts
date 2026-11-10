/**
 * What a notification says about the terminal it is for (#1908): which agent, on which machine, in which space and
 * terminal, and what it waits on. None of it rides in a push payload ({@link PushNotice} stays an id): the host names it
 * over the E2EE push stream, or the desktop app reads it off its own connection, and a device that cannot ask shows the
 * fixed sentence per kind.
 */
import type { Terminal } from "./__generated__/hc-api.ts";
import type { ScreenPrompt } from "./approval-rows.ts";
import { isJsonObject } from "./json.ts";
import type { NoticeKind } from "./push.ts";

export interface NoticeContext {
  /** The machine the terminal runs on, as people name it: the host's own name, or an added machine's. */
  readonly machine?: string;
  /** Its space: the `space` label, else its working directory's last segment. */
  readonly space?: string;
  /** Its name: a rename, else hc's name, else the program's title. */
  readonly terminal?: string;
  /** The agent's own name for itself (OSC 7501 `app`). */
  readonly agent?: string;
  /** The session title the agent set, when it says more than the terminal's name. */
  readonly session?: string;
  /** What it waits on, in the agent's words: the dialog's question or command, else its status message. */
  readonly ask?: string;
}

const FIELDS = ["machine", "space", "terminal", "agent", "session", "ask"] as const;

/** Each named field, at most this many characters; what it asks gets more room. */
export const MAX_NOTICE_FIELD = 64;
export const MAX_NOTICE_ASK = 160;
/** A title past this is cut by every platform: macOS and Android show about one line of it. */
export const MAX_NOTICE_TITLE = 64;
/** iOS shows about four lines of a body and Android's expanded text about as much; past this the platforms cut it. */
export const MAX_NOTICE_BODY = 240;

/** The sentence a device shows when it knows nothing about the notice: no host to ask, or one that named nothing. */
const SENTENCE: Readonly<Record<NoticeKind, string>> = {
  input: "An agent is waiting for your input.",
  permission: "An agent is asking for permission.",
  done: "An agent finished its turn.",
  error: "An agent stopped with an error.",
  test: "Notifications from this host work.",
};

/** What happened, after where it happened. */
const PHRASE: Readonly<Record<NoticeKind, string>> = {
  input: "Waiting for your input",
  permission: "Asking for permission",
  done: "Finished its turn",
  error: "Stopped with an error",
  test: "Notifications work",
};

/** Control characters and the marks that reorder text on screen: an agent's text must not draw a different line. */
const UNSHOWN = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** One line of shown text: no control characters, one space between words, at most `max` characters, `…` where cut. */
export function clipText(text: string, max: number): string {
  const line = text
    .replace(/[\t\n\r\v\f]/g, " ")
    .replace(UNSHOWN, "")
    .replace(/\s+/g, " ")
    .trim();
  const characters = [...line];
  return characters.length <= max ? line : `${characters.slice(0, max - 1).join("")}…`;
}

const limitOf = (field: (typeof FIELDS)[number]): number => (field === "ask" ? MAX_NOTICE_ASK : MAX_NOTICE_FIELD);

/** A context with every field cleaned and bounded, and the empty ones left out; undefined when nothing is left. */
function cleaned(fields: { readonly [K in (typeof FIELDS)[number]]?: unknown }): NoticeContext | undefined {
  const kept: Partial<Record<(typeof FIELDS)[number], string>> = {};
  for (const field of FIELDS) {
    const value = fields[field];
    if (typeof value !== "string") continue;
    const text = clipText(value, limitOf(field));
    if (text !== "") kept[field] = text;
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/** A context as another side sent it (the push stream, the desktop page): known string fields only, cleaned. */
export function parseNoticeContext(value: unknown): NoticeContext | undefined {
  return isJsonObject(value) ? cleaned(value) : undefined;
}

/** The label a renamed terminal carries (the web app's `TITLE_LABEL`). */
const RENAMED_LABEL = "herdr.name";
/** The name the web app gives a terminal only so its attach goes with the run (#1351): no name of its own. */
const OPENING_NAME = "opened-";

const nonEmpty = (text: string | null | undefined): string | undefined =>
  text === undefined || text === null || text === "" ? undefined : text;

function nameOf(terminal: Terminal): string | undefined {
  const name = nonEmpty(terminal.name);
  return (
    nonEmpty(terminal.labels[RENAMED_LABEL]) ??
    (name === undefined || name.startsWith(OPENING_NAME) ? undefined : name) ??
    nonEmpty(terminal.title)
  );
}

const lastSegment = (path: string): string | undefined => path.split("/").findLast((part) => part !== "");

/** What the agent waits on, as its dialog says it: a permission's verb and command, a question's own text. */
function askOf(prompt: ScreenPrompt): string | undefined {
  if (prompt.kind === "permission" && prompt.command !== "") return `${prompt.asks}: ${prompt.command}`;
  return nonEmpty(prompt.command) ?? nonEmpty(prompt.question);
}

/**
 * What a notice can say about a terminal: `machine` is where it runs (the host's own name for this core's terminals),
 * `prompt` the dialog it shows now, if any.
 */
export function noticeContextOf(terminal: Terminal, machine: string, prompt?: ScreenPrompt): NoticeContext {
  const name = nameOf(terminal);
  const session = nonEmpty(terminal.status?.title);
  return (
    cleaned({
      machine,
      space: terminal.labels["space"] ?? lastSegment(terminal.foreground?.cwd ?? terminal.cwd),
      terminal: name,
      agent: nonEmpty(terminal.status?.app) ?? prompt?.agent,
      session: session === name ? undefined : session,
      ask: (prompt === undefined ? undefined : askOf(prompt)) ?? nonEmpty(terminal.status?.msg),
    }) ?? {}
  );
}

export interface NoticeText {
  readonly title: string;
  readonly body: string;
}

/**
 * A notification's title and body: `agent@machine`, then where it runs and what happened, then what it asks, quoted.
 * With nothing named it is the app's name and the fixed sentence, as a device that cannot reach its host shows it.
 */
export function noticeText(kind: NoticeKind, context?: NoticeContext): NoticeText {
  const known = context === undefined ? undefined : cleaned(context);
  if (known === undefined) return { title: "Doriterm", body: SENTENCE[kind] };
  const who = [known.agent, known.machine].filter((part) => part !== undefined).join("@");
  const where = [known.space, known.terminal, known.session].filter(
    (part, index, parts): part is string => part !== undefined && parts.indexOf(part) === index,
  );
  const line = where.length === 0 ? PHRASE[kind] : `${where.join(" · ")} — ${PHRASE[kind]}`;
  const first = clipText(line, MAX_NOTICE_BODY);
  const room = MAX_NOTICE_BODY - [...first].length - 3;
  const ask = known.ask === undefined || room < 2 ? undefined : `“${clipText(known.ask, room)}”`;
  return {
    title: who === "" ? "Doriterm" : clipText(who, MAX_NOTICE_TITLE),
    body: ask === undefined ? first : `${first}\n${ask}`,
  };
}
