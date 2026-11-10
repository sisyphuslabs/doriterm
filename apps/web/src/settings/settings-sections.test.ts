import { describe, expect, test } from "bun:test";
import { CONNECT_GROUP, SECTIONS, sectionFromLink } from "./settings-sections.tsx";

describe("connecting a machine is part of Machines", () => {
  test("the navigation has no separate Connect a machine entry", () => {
    expect(SECTIONS.map((section) => section.label)).not.toContain("Connect a machine");
    expect(SECTIONS.map((section) => section.id as string)).not.toContain("pair");
  });

  test.each(["#pair", "#connect"])("an older link to %s opens Machines on its Connect a machine group", (hash) => {
    expect(sectionFromLink(hash)).toEqual({ section: "machines", group: CONNECT_GROUP });
  });

  test("a link names a section by its id, and anything else opens This device", () => {
    expect(sectionFromLink("#machines")).toEqual({ section: "machines" });
    expect(sectionFromLink("#voice")).toEqual({ section: "voice" });
    expect(sectionFromLink("")).toEqual({ section: "device" });
    expect(sectionFromLink("#nope")).toEqual({ section: "device" });
  });
});
