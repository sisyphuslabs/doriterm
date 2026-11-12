import type { Link } from "../link.ts";

const LF = "\n";

/** hc's answer to the hello: the first JSON-RPC response it writes, a line with an `id` and a `result` or an `error`. */
function isHelloAnswer(line: string): boolean {
  try {
    const message: unknown = JSON.parse(line);
    return (
      typeof message === "object" && message !== null && "id" in message && ("result" in message || "error" in message)
    );
  } catch {
    return false;
  }
}

/**
 * A pairing session's hc link on a host already at its plan's session limit: it carries the hello answer the pairing
 * waits for, and closes once that line has gone out, so the session limit holds for the session pairing leaves open as
 * the new device's workspace (#1271). The device is paired either way; its next session meets the limit as any other.
 * A line hc writes before the answer (none does today) goes out and does not close it: only the answer does (#1291).
 */
export function helloOnly(link: Link, close: () => void): Link {
  let answered = false;
  const decoder = new TextDecoder();
  let line = "";
  return {
    async send(bytes) {
      await link.send(bytes);
      if (answered) return;
      line += decoder.decode(bytes, { stream: true });
      for (let end = line.indexOf(LF); end !== -1; end = line.indexOf(LF)) {
        const complete = line.slice(0, end);
        line = line.slice(end + 1);
        if (!isHelloAnswer(complete)) continue;
        answered = true;
        close();
        return;
      }
    },
    onData: (handler) => link.onData(handler),
    onClose: (handler) => link.onClose(handler),
    close: () => link.close(),
  };
}
