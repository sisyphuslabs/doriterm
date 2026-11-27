import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MachineHeader } from "./machine-header.tsx";

const header = (onToggle?: () => void): string =>
  renderToStaticMarkup(
    <MachineHeader
      name="studio"
      local
      state="connected"
      tabs={2}
      connected
      onNewSpace={() => {}}
      {...(onToggle === undefined ? {} : { onToggle })}
    />,
  );

/** The classes of the header's leading chevron, or the slot kept for it. */
const chevronClasses = (markup: string): readonly string[] => {
  const all = [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1] ?? "");
  return (all.find((classes) => classes.split(" ").includes("size-6")) ?? "").split(" ");
};

test("the slot kept for the chevron does not shrink, as the chevron it stands for does not (#2024)", () => {
  expect(chevronClasses(header(() => {}))).toContain("shrink-0");
  expect(chevronClasses(header())).toContain("shrink-0");
});
