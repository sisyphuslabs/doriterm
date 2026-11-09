// Section rhythm as the visual-QA gate measures it (#1496), from the text edges a reader sees: a heading has at least
// 1.5x more space above it than below it, and a group sits at least 2x further from the next group than its own lines
// sit from each other. Runs in the page through `page.evaluate`, so its helpers live inside it.

export interface Rhythm {
  readonly headings: readonly { readonly name: string; readonly above: number; readonly below: number }[];
  readonly groups: readonly { readonly name: string; readonly inter: number; readonly intra: readonly number[] }[];
}

/** A sidebar section's title against the label column of the first row it heads (#1496). */
export interface SectionTitleAlignment {
  /** The section's title, as it reads. */
  readonly name: string;
  /** The title text's left edge, in CSS pixels. */
  readonly title: number;
  /** The first row's label text left edge, or null when the section holds no labelled row. */
  readonly row: number | null;
}

export function sectionRhythm(): Rhythm {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function as source, so its helpers live inside it
  const visible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (style.visibility !== "visible" || style.display === "none" || box.width < 2 || box.height < 2) return false;
    if (Number(style.opacity) === 0) return false;
    if (box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight) return false;
    let [left, top, right, bottom] = [
      Math.max(0, box.left),
      Math.max(0, box.top),
      Math.min(innerWidth, box.right),
      Math.min(innerHeight, box.bottom),
    ];
    for (let parent = el.parentElement; parent !== null; parent = parent.parentElement) {
      const own = getComputedStyle(parent);
      const edge = parent.getBoundingClientRect();
      if (own.display === "none" || own.visibility === "hidden" || Number(own.opacity) === 0) return false;
      if (own.overflowX !== "visible") [left, right] = [Math.max(left, edge.left), Math.min(right, edge.right)];
      if (own.overflowY !== "visible") [top, bottom] = [Math.max(top, edge.top), Math.min(bottom, edge.bottom)];
    }
    if (right - left < 1 || bottom - top < 1) return false;
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return hit === null || hit === el || el.contains(hit) || hit.contains(el);
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- as above
  const textBox = (el: Element): DOMRect => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect();
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- as above
  const nameOf = (el: Element): string => (el.textContent ?? "").trim().replaceAll(/\s+/g, " ").slice(0, 40);
  const all = [...document.querySelectorAll("body *")].filter(visible);
  const texts = all
    .filter((el) => [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()))
    .map((el) => ({ el, box: textBox(el) }));

  const headings = all
    .filter((el) => el.matches("h1,h2,h3,h4,h5,h6,[role=heading]"))
    .flatMap((el) => {
      const own = textBox(el);
      const region =
        el.closest("[data-slot=settings-body],[data-slot=agents-list],main,[role=dialog],aside") ?? document.body;
      const column = texts.filter(
        (t) =>
          region.contains(t.el) &&
          !el.contains(t.el) &&
          !t.el.contains(el) &&
          Math.min(t.box.right, own.right) - Math.max(t.box.left, own.left) > Math.min(t.box.width, own.width) * 0.25,
      );
      const before = column.filter((t) => t.box.bottom <= own.top).toSorted((a, b) => b.box.bottom - a.box.bottom)[0];
      const after = column.filter((t) => t.box.top >= own.bottom).toSorted((a, b) => a.box.top - b.box.top)[0];
      if (before === undefined || after === undefined) return [];
      return [{ name: nameOf(el), above: own.top - before.box.bottom, below: after.box.top - own.bottom }];
    });

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- as above
  const isGroup = (el: Element) =>
    el.matches("section,fieldset,[role=group],[data-mesh-group]") ||
    [...el.children].some((c) => c.matches("h2,h3,h4"));
  const candidates = all.filter(isGroup);
  const groups = candidates.flatMap((el) => {
    const box = el.getBoundingClientRect();
    const next = candidates
      .filter((g) => g !== el && !el.contains(g) && !g.contains(el))
      .filter((g) => {
        const other = g.getBoundingClientRect();
        return other.y >= box.bottom && Math.min(other.right, box.right) > Math.max(other.x, box.x);
      })
      .toSorted((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)[0];
    const own = texts.filter((t) => el.contains(t.el)).toSorted((a, b) => a.box.top - b.box.top);
    const following = next === undefined ? [] : texts.filter((t) => next.contains(t.el)).map((t) => t.box.top);
    if (own.length === 0 || following.length === 0) return [];
    const inter = Math.min(...following) - Math.max(...own.map((t) => t.box.bottom));
    const intra = own.slice(1).map((t, i) => t.box.top - (own[i]?.box.bottom ?? t.box.top));
    return [{ name: nameOf(el), inter, intra: intra.filter((gap) => Math.round(gap * 1000) > 0) }];
  });
  return { headings, groups };
}

/**
 * The sidebar's section titles and the label column of the first row each heads (#1496), from the text edges a reader
 * sees. Runs in the page through `page.evaluate`, so its helpers live inside it.
 */
export function sectionTitleAlignments(): readonly SectionTitleAlignment[] {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function as source, so its helpers live inside it
  const textLeft = (el: Element): number => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().left;
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- as above
  const shown = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    return box.width >= 2 && box.height >= 2 && getComputedStyle(el).visibility === "visible";
  };
  const sidebar = document.querySelector("aside[aria-label=Workspace]");
  if (sidebar === null) return [];
  return [...sidebar.querySelectorAll("h2")].filter(shown).map((title) => {
    const section = title.closest("section");
    const row = section === null ? undefined : [...section.querySelectorAll("[data-floor=name]")].find(shown);
    return {
      name: (title.textContent ?? "").trim(),
      title: textLeft(title),
      row: row === undefined ? null : textLeft(row),
    };
  });
}
