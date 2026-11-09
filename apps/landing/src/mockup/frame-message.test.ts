import { expect, test } from "bun:test";
import { applyFrameMessage } from "./frame-message.ts";

const root = (): Pick<HTMLElement, "dataset"> => ({ dataset: {} as DOMStringMap });

test("the landing's pinned theme maps to the app's preset, and system lets the mockup follow the page", () => {
  const html = root();
  applyFrameMessage(html, { theme: "dark" });
  expect(html.dataset["theme"]).toBe("night");
  applyFrameMessage(html, { theme: null });
  expect(html.dataset["theme"]).toBeUndefined();
});

test("the landing's motion toggle pauses the mockup's animations and resumes them (#1179)", () => {
  const html = root();
  applyFrameMessage(html, { motionPaused: true });
  expect(html.dataset["motion"]).toBe("paused");
  // A theme message alone leaves the pause as it was.
  applyFrameMessage(html, { theme: "light" });
  expect(html.dataset["motion"]).toBe("paused");
  applyFrameMessage(html, { motionPaused: false });
  expect(html.dataset["motion"]).toBeUndefined();
});
