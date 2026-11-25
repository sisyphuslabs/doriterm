/** Where an invite's fragment ends inside pasted text: a space, a quote or an angle bracket (shell and chat wrapping). */
const FRAGMENT_END = /[\s'"<>`]/;

/**
 * The invite inside `text`, as the field should read it: the `#…` fragment cut at the first character that wraps it,
 * or the text itself when it has no fragment (a typed code). A person pastes whatever they were given: the bare link,
 * or the whole install line `curl … | DORIFACE_JOIN='<doriface://pair#…&m=1>' sh`, whose trailing `>' sh` read as part of
 * the last parameter turned a mesh invite (`m=1`) into a device pairing the host refused (#2795).
 */
export function inviteIn(text: string): string {
  const hash = text.indexOf("#");
  if (hash === -1) return text.trim();
  const rest = text.slice(hash);
  const end = rest.search(FRAGMENT_END);
  return end === -1 ? rest : rest.slice(0, end);
}

/** What the field says when the pasted invite is this app's own offer for another machine (#2795). */
export const OWN_INVITE =
  "This is this app's invite for adding another machine. Run the whole line in that machine's terminal; pasting it here would use up the invite.";

/**
 * Whether `hostId` (the invite's host) is one this app already reaches: its selected host or a member of its roster. Such an
 * invite is the one the app itself shows for adding another machine, and redeeming it here would spend it (#2795).
 */
export function isOwnInvite(
  hostId: string,
  known: { readonly hostId: string; readonly members: readonly { readonly hostId: string }[] },
): boolean {
  return hostId !== "" && (known.hostId === hostId || known.members.some((member) => member.hostId === hostId));
}
