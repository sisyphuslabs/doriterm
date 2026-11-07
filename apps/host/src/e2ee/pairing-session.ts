import type { Link } from "../link.ts";

const LF = 0x0a;

/**
 * A pairing session's hc link on a host already at its plan's session limit: it carries the hello answer the pairing
 * waits for, and closes once that line has gone out, so the session limit holds for the session pairing leaves open as
 * the new device's workspace (#1271). The device is paired either way; its next session meets the limit as any other.
 */
export function helloOnly(link: Link, close: () => void): Link {
  let answered = false;
  return {
    async send(bytes) {
      await link.send(bytes);
      if (answered || !bytes.includes(LF)) return;
      answered = true;
      close();
    },
    onData: (handler) => link.onData(handler),
    onClose: (handler) => link.onClose(handler),
    close: () => link.close(),
  };
}
