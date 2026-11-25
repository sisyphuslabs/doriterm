// The docs pages' one module: the nav's theme switch, a Copy button on each code block, and the table of contents
// marking the section being read. Nothing on a docs page moves, so none of the landing's scenes load here.
import { bindCopy } from "./copy.js";
import { setupTheme } from "./theme.js";

function setupCode() {
  for (const block of document.querySelectorAll(".code")) {
    const source = block.querySelector("pre");
    bindCopy(block.querySelector("[data-copy]"), () => source.textContent);
  }
}

/** Marks the contents link of the last heading scrolled past the nav (the last one once the page ends). */
function setupToc() {
  const links = [...document.querySelectorAll(".toc a")];
  if (links.length === 0) return;
  const headings = links.map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))));
  const line = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) + 40;
  let frame = 0;
  const mark = () => {
    frame = 0;
    const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
    let current = atEnd ? headings.length - 1 : 0;
    if (!atEnd) headings.forEach((heading, i) => heading.getBoundingClientRect().top <= line && (current = i));
    links.forEach((link, i) => {
      if (i === current) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  };
  addEventListener("scroll", () => (frame ||= requestAnimationFrame(mark)), { passive: true });
  mark();
}

setupTheme();
setupCode();
setupToc();
