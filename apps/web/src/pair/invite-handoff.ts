import { bridgeMethod } from "../desktop/bridge.ts";

const UNREADABLE =
  "Doriterm could not read the clipboard. Paste the invite into the field with Ctrl+V (Cmd+V on a Mac).";
const NO_GESTURE =
  "Doriterm reads the clipboard only when you click Paste invite. Click it again, or paste into the field.";
const NOT_INVITE = "The clipboard holds no Doriterm invite link. Copy the whole link, or type its code into the field.";

/** Only an expiring invitation crosses the iOS storage partitions; neither private key is exported. */
export async function carryInvite(
  link: string,
  clipboard: Pick<Clipboard, "writeText"> = navigator.clipboard,
): Promise<void> {
  await clipboard.writeText(link);
}

/**
 * The desktop shell's Paste invite, or null in a browser. The app page may not read the clipboard, so the shell reads
 * it on the click and hands over only an invite link (#2656).
 */
export function desktopPasteInvite(scope: object = globalThis): (() => Promise<string>) | null {
  const paste = bridgeMethod("pasteInvite", scope);
  if (paste === null) return null;
  return async () => {
    const answer: unknown = await paste();
    const field = (key: string): unknown =>
      typeof answer === "object" && answer !== null ? Reflect.get(answer, key) : undefined;
    const link = field("link");
    if (typeof link === "string") return link;
    throw new Error(field("refused") === "gesture" ? NO_GESTURE : NOT_INVITE);
  };
}

async function readClipboard(clipboard: Pick<Clipboard, "readText">): Promise<string> {
  try {
    return await clipboard.readText();
  } catch {
    throw new Error(UNREADABLE);
  }
}

export async function pasteInvite(
  clipboard: Pick<Clipboard, "readText" | "writeText"> = navigator.clipboard,
  desktop: (() => Promise<string>) | null = desktopPasteInvite(),
): Promise<string> {
  const link = desktop === null ? await readClipboard(clipboard) : await desktop();
  await clipboard.writeText("");
  return link;
}
