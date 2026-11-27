import { describe, expect, test } from "bun:test";
import { CONNECT_GROUP, SECTIONS, groupSections, sectionFromLink } from "./settings-sections.tsx";

describe("connecting a machine is part of Machines", () => {
  test("the navigation has no separate Connect a machine entry", () => {
    expect(SECTIONS.map((section) => section.label)).not.toContain("Connect a machine");
    expect(SECTIONS.map((section) => section.id as string)).not.toContain("pair");
  });

  test.each(["#pair", "#connect"])("an older link to %s opens Machines on its Connect a machine group", (hash) => {
    expect(sectionFromLink(hash)).toEqual({ section: "machines", group: CONNECT_GROUP, named: true });
  });

  test("a link names a section by its id, and anything else opens This device", () => {
    expect(sectionFromLink("#machines")).toEqual({ section: "machines", named: true });
    expect(sectionFromLink("#skills")).toEqual({ section: "skills", named: true });
    expect(sectionFromLink("#voice")).toEqual({ section: "voice", named: true });
    expect(sectionFromLink("")).toEqual({ section: "device", named: false });
    expect(sectionFromLink("#nope")).toEqual({ section: "device", named: false });
  });

  test("the groups keep the navigation's order, each listed once", () => {
    const groups = groupSections(SECTIONS);
    expect(groups.map((entry) => entry.group)).toEqual(["Connection", "Look", "Input", "More"]);
    expect(groups.flatMap((entry) => entry.entries)).toEqual([...SECTIONS]);
  });
});
