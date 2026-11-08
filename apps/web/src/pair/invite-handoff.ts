/** Only an expiring invitation crosses the iOS storage partitions; neither private key is exported. */
export async function carryInvite(
  link: string,
  clipboard: Pick<Clipboard, "writeText"> = navigator.clipboard,
): Promise<void> {
  await clipboard.writeText(link);
}

export async function pasteInvite(
  clipboard: Pick<Clipboard, "readText" | "writeText"> = navigator.clipboard,
): Promise<string> {
  const link = await clipboard.readText();
  await clipboard.writeText("");
  return link;
}
