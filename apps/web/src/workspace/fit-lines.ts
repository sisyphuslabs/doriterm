import { type RefObject, useLayoutEffect, useState } from "react";

const ELLIPSIS = "\u2026";
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface Piece {
  readonly at: number;
  readonly end: number;
  readonly space: boolean;
}

/** The text's words and the spaces between them; a word wider than a line comes as its characters instead. */
function piecesOf(text: string, width: number, measure: (text: string) => number): Piece[] {
  return [...words.segment(text)].flatMap(({ segment, index }) => {
    const space = segment.trim() === "";
    if (space || measure(segment) <= width) return [{ at: index, end: index + segment.length, space }];
    return [...graphemes.segment(segment)].map((part) => ({
      at: index + part.index,
      end: index + part.index + part.segment.length,
      space: false,
    }));
  });
}

/**
 * `text` broken into at most `max` lines no wider than `width`: at word boundaries, a word wider than a line at its
 * characters. When it needs more lines, the last one ends in an ellipsis where the rest no longer fits.
 */
export function fitLines(text: string, width: number, measure: (text: string) => number, max = 2): string[] {
  const lines: { start: number; end: number }[] = [];
  let line: { start: number; end: number } | undefined;
  for (const piece of piecesOf(text, width, measure)) {
    if (line === undefined) {
      if (!piece.space) line = { start: piece.at, end: piece.end };
      continue;
    }
    if (measure(text.slice(line.start, piece.end).trimEnd()) <= width) {
      line.end = piece.end;
      continue;
    }
    lines.push(line);
    line = piece.space ? undefined : { start: piece.at, end: piece.end };
  }
  if (line !== undefined) lines.push(line);
  const shown = lines.map(({ start, end }) => text.slice(start, end).trimEnd());
  if (lines.length <= max) return shown;
  const last = lines[max - 1];
  const rest = [...graphemes.segment(text.slice(last?.start ?? 0).trimEnd())].map(({ segment }) => segment);
  while (rest.length > 0 && measure(rest.join("").trimEnd() + ELLIPSIS) > width) rest.pop();
  return [...shown.slice(0, max - 1), rest.join("").trimEnd() + ELLIPSIS];
}

let pen: CanvasRenderingContext2D | null | undefined;

/** `text` fitted to the element's width in its own font, as `fitLines` breaks it; fitted again when the width changes. */
export function useFittedLines(element: RefObject<HTMLElement | null>, text: string, max = 2): readonly string[] {
  const [fitted, setFitted] = useState<{ readonly text: string; readonly lines: readonly string[] }>({
    text,
    lines: [text],
  });
  useLayoutEffect(() => {
    const el = element.current;
    if (el === null) return undefined;
    const fit = (): void => {
      pen ??= document.createElement("canvas").getContext("2d");
      const width = el.clientWidth;
      if (pen === null || width <= 0) return;
      const style = getComputedStyle(el);
      pen.font = style.font;
      pen.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
      const font = pen;
      const lines = fitLines(text, width, (part) => font.measureText(part).width, max);
      setFitted((before) =>
        before.text === text && before.lines.join("\n") === lines.join("\n") ? before : { text, lines },
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [element, text, max]);
  return fitted.text === text ? fitted.lines : [text];
}
