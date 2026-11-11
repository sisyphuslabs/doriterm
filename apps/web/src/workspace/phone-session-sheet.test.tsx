import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionPlace } from "./phone-session-sheet.tsx";

const lines = (dir: string | undefined): readonly string[] =>
  [...renderToStaticMarkup(<SessionPlace where="host · work" dir={dir} />).matchAll(/<p[^>]*>([^<]*)<\/p>/g)].map(
    (match) => match[1] ?? "",
  );

describe("the phone session sheet's place (#1502)", () => {
  test("says where the session lives, then its directory", () => {
    expect(lines("/work/doriface")).toEqual(["host · work", "/work/doriface"]);
  });

  test("a terminal with no directory draws no directory line, not an empty one", () => {
    expect(lines("")).toEqual(["host · work"]);
    expect(lines(undefined)).toEqual(["host · work"]);
  });
});
