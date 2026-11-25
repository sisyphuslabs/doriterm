import type { KeyholderRequest } from "@doriface/vault";

/** The ends of a Worker's message channel this module uses: the worker itself on the page side, its global inside. */
export interface Port {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

/** The page side: each keyholder call is one numbered message, answered by the worker with the same number. */
export function callOver(port: Port): (request: KeyholderRequest) => Promise<unknown> {
  let next = 0;
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (cause: Error) => void }>();
  port.addEventListener("message", (event) => {
    const seq = field(event.data, "seq");
    const pending = typeof seq === "number" ? waiting.get(seq) : undefined;
    if (pending === undefined || typeof seq !== "number") return;
    waiting.delete(seq);
    const error = field(event.data, "error");
    if (typeof error === "string") pending.reject(new Error(error));
    else pending.resolve(field(event.data, "value"));
  });
  return (request) =>
    new Promise((resolve, reject) => {
      next += 1;
      waiting.set(next, { resolve, reject });
      port.postMessage({ seq: next, request });
    });
}

/** The worker side: answers every numbered request through `serve`, which holds the keys. */
export function answerOn(port: Port, serve: Promise<(request: unknown) => Promise<unknown>>): void {
  port.addEventListener("message", (event) => {
    const seq = field(event.data, "seq");
    if (typeof seq !== "number") return;
    serve
      .then((answer) => answer(field(event.data, "request")))
      .then(
        (value) => port.postMessage({ seq, value }),
        (cause: unknown) => port.postMessage({ seq, error: cause instanceof Error ? cause.message : String(cause) }),
      );
  });
}
