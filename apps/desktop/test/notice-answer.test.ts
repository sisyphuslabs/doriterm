import { describe, expect, test } from "bun:test";
import { SETTLE_MS, type Shown, showAndAnswer, type Wait } from "../src/main/notice-answer.ts";

type Listener = (event: unknown, error: string) => void;

function notification(outcome: (listeners: Map<string, Listener>) => void): Shown {
  const listeners = new Map<string, Listener>();
  return {
    once(event: string, listener: Listener) {
      listeners.set(event, listener);
    },
    show() {
      outcome(listeners);
    },
  };
}

function waits() {
  const pending: { ms: number; step: () => void; cancelled: boolean }[] = [];
  const wait: Wait = (ms, step) => {
    const entry = { ms, step, cancelled: false };
    pending.push(entry);
    return () => void (entry.cancelled = true);
  };
  return { wait, pending };
}

describe("what showing a notification comes to", () => {
  test("the OS showing it is accepted, and its settle timer is dropped", async () => {
    const { wait, pending } = waits();
    const shown = notification((listeners) => listeners.get("show")?.(undefined, ""));
    expect(await showAndAnswer(shown, wait)).toEqual({ accepted: true });
    expect(pending.every((entry) => entry.cancelled)).toBe(true);
  });

  test("the OS failing it, or show() throwing, is a refusal naming why", async () => {
    const { wait } = waits();
    const failed = notification((listeners) => listeners.get("failed")?.(undefined, "no notification service"));
    expect(await showAndAnswer(failed, wait)).toEqual({ accepted: false, reason: "no notification service" });
    const threw = notification(() => {
      throw new Error("not supported");
    });
    expect(await showAndAnswer(threw, wait)).toEqual({ accepted: false, reason: "not supported" });
  });

  test("no answer within the settle window is accepted, and a late failure changes nothing", async () => {
    const { wait, pending } = waits();
    let listeners: Map<string, Listener> | undefined;
    const quiet = notification((heard) => void (listeners = heard));
    const answering = showAndAnswer(quiet, wait);
    expect(pending.map((entry) => entry.ms)).toEqual([SETTLE_MS]);
    pending[0]?.step();
    expect(await answering).toEqual({ accepted: true });
    listeners?.get("failed")?.(undefined, "too late");
    expect(await answering).toEqual({ accepted: true });
  });
});
