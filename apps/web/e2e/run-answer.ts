import type { HcSocket } from "./hc-socket.ts";

/** The ids of the page's terminal.run requests, in the order it sent them. */
const runIds = (link: HcSocket): string[] =>
  link.sent().flatMap((frame) => {
    if (!frame.includes('"method":"terminal.run"')) return [];
    const id = /"id":(\d+)/.exec(frame)?.[1];
    return id === undefined ? [] : [id];
  });

/**
 * Holds the host's answer to the page's next terminal.run, picked by that request's id, until the returned release: a
 * loaded host slow to answer the run. Only that answer: End's calls on the same terminal answer with the same record,
 * so a needle on the record would hold them too.
 */
export function holdRunAnswer(link: HcSocket): () => void {
  const before = runIds(link).length;
  return link.holdFromHost((frame) => {
    const id = runIds(link)[before];
    return id !== undefined && frame.includes(`{"id":${id},`);
  });
}
