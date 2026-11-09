import { HcRpcError, type JsonRpcResponse, type JsonValue } from "@doriface/protocol";

interface Pending {
  readonly settle: (response: JsonRpcResponse) => boolean;
  readonly fail: (error: Error) => void;
}

/** In-flight channel-0 calls by id. Replies may arrive in any order; ids are never reused. */
export class PendingCalls {
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();

  /**
   * `adopt` runs synchronously while the reply frame is dispatched, so a call that opens a stream
   * can claim its channel before the next frame, which may already belong to that stream, is read.
   * `answered` runs first, on a reply of either kind, so its caller can measure the round trip that produced it.
   */
  start<T>(
    adopt: (result: JsonValue) => T,
    answered: () => void = () => {},
  ): { readonly id: number; readonly promise: Promise<T> } {
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.#pending.set(id, {
      settle: (response) => {
        answered();
        if (response.kind === "failure") {
          reject(new HcRpcError(response.error));
          return true;
        }
        try {
          resolve(adopt(response.result));
          return true;
        } catch (error) {
          reject(error);
          return false;
        }
      },
      fail: reject,
    });
    return { id, promise };
  }

  /**
   * False when no call took the reply: none waits for this id (it timed out, was aborted, or never
   * existed), or its `adopt` refused the result. Either way, anything the reply opened is unowned.
   */
  settle(response: JsonRpcResponse): boolean {
    if (typeof response.id !== "number") return false;
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return false;
    this.#pending.delete(response.id);
    return pending.settle(response);
  }

  forget(id: number): void {
    this.#pending.delete(id);
  }

  failAll(error: Error): void {
    const pending = Array.from(this.#pending.values());
    this.#pending.clear();
    for (const call of pending) call.fail(error);
  }

  get size(): number {
    return this.#pending.size;
  }
}
