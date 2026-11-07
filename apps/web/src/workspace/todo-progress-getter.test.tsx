import type { HcConnection } from "@doriface/client";
import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type TodoOf, useTodoProgress } from "./todo-progress.ts";

/** A core that is never asked anything: no effect runs in a server render, so no read is made. */
const connection = {} as unknown as HcConnection;

/** Renders Workspace's use of the hook several times over with nothing changed, keeping each getter it returned. */
function gettersOver(renders: number): readonly TodoOf[] {
  const seen: TodoOf[] = [];
  function Probe() {
    const [count, setCount] = useState(1);
    seen.push(useTodoProgress(connection, []));
    if (count < renders) setCount(count + 1);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return seen;
}

describe("useTodoProgress", () => {
  test("the getter keeps its identity across renders while no progress changed, so the agents memo holds (#910)", () => {
    const seen = gettersOver(3);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(1);
  });
});
