import { expect, test } from "bun:test";
import { keepScroll, type KeptScroller } from "./kept-scroll.ts";

class FakeScroller extends EventTarget implements KeptScroller {
  scrollTop = 0;
  scrollTo(top: number): void {
    this.scrollTop = top;
    this.dispatchEvent(new Event("scroll"));
  }
}

test("a scroll is kept under the key in view at that scroll, not the one the listener started with (#1563)", () => {
  const store = new Map<string, number>();
  const scroller = new FakeScroller();
  let key = "space:a";
  keepScroll(scroller, () => key, store);

  scroller.scrollTo(120);
  key = "space:b";
  scroller.scrollTo(40);

  expect(store.get("space:a")).toBe(120);
  expect(store.get("space:b")).toBe(40);
});

test("a detached scroller keeps nothing more", () => {
  const store = new Map<string, number>();
  const scroller = new FakeScroller();
  const detach = keepScroll(scroller, () => "agents", store);
  scroller.scrollTo(10);
  detach();
  scroller.scrollTo(99);
  expect(store.get("agents")).toBe(10);
});
