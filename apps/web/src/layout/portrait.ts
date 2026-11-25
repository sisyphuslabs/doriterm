import { childrenOf, typeOf, type Node } from "@doriface/protocol/layout";

/**
 * The tree as a medium screen in portrait shows it: every row a column, so side-by-side panes stack top to bottom
 * (design proposal section 4). Ids and sizes stay, so a divider dragged here resizes the same container in the document.
 */
export function stackRows(node: Node): Node {
  const children = childrenOf(node);
  const stacked = children.map(stackRows);
  const changed = stacked.some((child, index) => child !== children[index]);
  if (typeOf(node) !== "row" && !changed) return node;
  return {
    ...node,
    ...(typeOf(node) === "row" ? { type: "column" } : {}),
    ...(changed ? { children: stacked } : {}),
  };
}
