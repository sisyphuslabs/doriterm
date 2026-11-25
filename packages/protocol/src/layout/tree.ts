import { isJsonObject } from "../json.ts";
import {
  childrenOf,
  idOf,
  isContainer,
  typeOf,
  weightOf,
  withField,
  withoutField,
  type Axis,
  type Node,
} from "./node.ts";

export interface PaneRef {
  readonly id: string;
  /** The terminal's address in this machine's document, or null for a herdr-app panel. */
  readonly terminal: string | null;
  readonly mod: string | null;
}

export function terminalBlock(id: string, address: string): Node {
  return { content: { terminal: address }, id, type: "block" };
}

function paneOf(node: Node): PaneRef | null {
  const content = node["content"];
  if (typeOf(node) !== "block" || !isJsonObject(content)) return null;
  const terminal = typeof content["terminal"] === "string" ? content["terminal"] : null;
  const mod = typeof content["mod"] === "string" ? content["mod"] : null;
  return terminal === null && mod === null ? null : { id: idOf(node), terminal, mod };
}

export function panesOf(root: Node): readonly PaneRef[] {
  const pane = paneOf(root);
  return pane === null ? childrenOf(root).flatMap(panesOf) : [pane];
}

/** Child indices from `root` down to the node `id`; empty for the root itself, null when it is not in the tree. */
export function pathTo(root: Node, id: string): readonly number[] | null {
  if (idOf(root) === id) return [];
  const children = childrenOf(root);
  for (const [index, child] of children.entries()) {
    const below = pathTo(child, id);
    if (below !== null) return [index, ...below];
  }
  return null;
}

export function nodeAt(root: Node, path: readonly number[]): Node | null {
  let here: Node | undefined = root;
  for (const index of path) here = here === undefined ? undefined : childrenOf(here)[index];
  return here ?? null;
}

/** The tree with the node at `path` replaced; nodes off that path are the objects that were there. */
export function replaceAt(root: Node, path: readonly number[], replace: (node: Node) => Node): Node {
  const [index, ...rest] = path;
  if (index === undefined) return replace(root);
  const children = childrenOf(root);
  const child = children[index];
  if (child === undefined) return root;
  return { ...root, children: children.with(index, replaceAt(child, rest, replace)) };
}

/**
 * The tree without the pane `id`, herdr-app's `Node::remove`: its share goes to the neighbour it was split from (the
 * one before it, else the next), and a row or column left with one child gives way to that child, which takes its
 * slot size. Only containers on the way to the pane are touched. Null when the pane is not in the tree.
 */
export function removePane(root: Node, id: string): Node | null {
  const path = pathTo(root, id);
  const at = path?.at(-1);
  if (path === null || at === undefined) return null;
  const parentPath = path.slice(0, -1);
  const parent = nodeAt(root, parentPath);
  const gone = nodeAt(root, path);
  if (parent === null || gone === null) return null;
  const kept = childrenOf(parent).filter((_, index) => index !== at);
  const heir = Math.max(0, at - 1);
  const goneWeight = weightOf(gone);
  const heirNode = kept[heir];
  const heirWeight = heirNode === undefined ? null : weightOf(heirNode);
  const inherited =
    typeOf(parent) !== "stack" && heirNode !== undefined && goneWeight !== null && heirWeight !== null
      ? kept.with(heir, withField(heirNode, "size", { weight: heirWeight + goneWeight }))
      : kept;
  // As herdr-app's remove_inner: a stack whose active child closed activates the one sliding into its place, or the last.
  const stackActive = (node: Node): Node => {
    if (typeOf(node) !== "stack" || node["active"] !== id) return node;
    const successor = inherited[at] ?? inherited.at(-1);
    return successor === undefined ? withoutField(node, "active") : { ...node, active: idOf(successor) };
  };
  let next = replaceAt(root, parentPath, (node) => stackActive({ ...node, children: inherited }));
  for (let depth = parentPath.length; depth > 0; depth -= 1) {
    const containerPath = path.slice(0, depth);
    const container = nodeAt(next, containerPath);
    if (container === null || (typeOf(container) !== "row" && typeOf(container) !== "column")) continue;
    const children = childrenOf(container);
    const only = children[0];
    if (children.length === 0) {
      next = replaceAt(next, containerPath.slice(0, -1), (node) => ({
        ...node,
        children: childrenOf(node).filter((_, index) => index !== containerPath.at(-1)),
      }));
    } else if (children.length === 1 && only !== undefined) {
      const slot = container["size"];
      next = replaceAt(next, containerPath, () =>
        slot === undefined ? withoutField(only, "size") : withField(only, "size", slot),
      );
    }
  }
  return next;
}

/** herdr-app keeps weights as f32; six places keep the document readable and the sum exact enough. */
const round = (weight: number): number => Math.round(weight * 1e6) / 1e6;

/** The smallest share a pane keeps of its row or column when resized, so a drag never makes it vanish. */
export const MIN_SHARE = 0.05;

/**
 * The tree with the line between children `index` and `index + 1` of a row or column moved by `delta`, a fraction of
 * that container's length (positive: toward the end). Only those two children's weights change, their sum stays, and
 * neither drops below MIN_SHARE of the container. Null when that line does not exist or a side is sized in pixels.
 */
export function resizeAt(root: Node, container: string, index: number, delta: number): Node | null {
  const path = pathTo(root, container);
  const node = path === null ? null : nodeAt(root, path);
  if (path === null || node === null || (typeOf(node) !== "row" && typeOf(node) !== "column")) return null;
  const children = childrenOf(node);
  const [before, after] = [children[index], children[index + 1]];
  if (before === undefined || after === undefined) return null;
  const weights = children.map(weightOf);
  const [a, b] = [weights[index], weights[index + 1]];
  if (a == null || b == null || weights.some((weight) => weight === null)) return null;
  const total = weights.reduce<number>((sum, weight) => sum + (weight ?? 0), 0);
  const floor = MIN_SHARE * total;
  const moved = Math.min(Math.max(delta * total, floor - a), b - floor);
  if (Math.abs(moved) < 1e-9) return null;
  const next = children
    .with(index, withField(before, "size", { weight: round(a + moved) }))
    .with(index + 1, withField(after, "size", { weight: round(b - moved) }));
  return replaceAt(root, path, (each) => ({ ...each, children: next }));
}

/** Every row and column of the tree shares its length evenly (Ghostty's `equalize_splits`); pixel sizes stay. */
export function equalize(root: Node): Node {
  const children = childrenOf(root);
  if (children.length === 0) return root;
  const even = typeOf(root) === "row" || typeOf(root) === "column";
  let changed = false;
  const next = children.map((child) => {
    let out = equalize(child);
    const weight = weightOf(out);
    if (even && weight !== null && weight !== 1 && out["size"] !== undefined)
      out = withField(out, "size", { weight: 1 });
    if (out !== child) changed = true;
    return out;
  });
  return changed ? { ...root, children: next } : root;
}

/** `node` sized as `slot` is: the size belongs to the place in the tree, not to the pane that fills it. */
function inSlotOf(node: Node, slot: Node): Node {
  const size = slot["size"];
  return size === undefined ? withoutField(node, "size") : withField(node, "size", size);
}

/**
 * The tree with panes `a` and `b` in each other's place, herdr-app's `Node::swap`: each place keeps its size, so the two
 * trade where they are drawn and nothing else moves. Null when either is not a pane of this tree or they are one pane.
 */
export function swapPanes(root: Node, a: string, b: string): Node | null {
  const [pathA, pathB] = [pathTo(root, a), pathTo(root, b)];
  if (a === b || pathA === null || pathB === null) return null;
  const [nodeA, nodeB] = [nodeAt(root, pathA), nodeAt(root, pathB)];
  if (nodeA === null || nodeB === null || isContainer(nodeA) || isContainer(nodeB)) return null;
  const once = replaceAt(root, pathA, () => inSlotOf(nodeB, nodeA));
  return replaceAt(once, pathB, () => inSlotOf(nodeA, nodeB));
}

/** The pane `id` of the tree (a block, never a container), or null when the tree has no such pane. */
export function paneNode(root: Node, id: string): Node | null {
  const path = pathTo(root, id);
  const node = path === null ? null : nodeAt(root, path);
  return node === null || isContainer(node) ? null : node;
}

/**
 * The tree with pane `id` replaced by `node` in its place, which keeps the place's size: the move of a pane from another
 * tab into this one, or a swap across tabs. Null when `id` is not a pane of this tree.
 */
export function replacePane(root: Node, id: string, node: Node): Node | null {
  const path = pathTo(root, id);
  const old = path === null ? null : nodeAt(root, path);
  if (path === null || old === null || isContainer(old)) return null;
  return replaceAt(root, path, () => inSlotOf(node, old));
}

/** A side of a pane another is dropped on: the drop puts it there, sharing that pane's place. */
export type Edge = "left" | "right" | "top" | "bottom";

/**
 * The tree with `block` beside pane `target` on `edge` of it: it splits the target's place along the edge's axis, before
 * the target for left and top, as herdr-app's `move_pane` puts a dropped pane. Null when the target is not a pane here.
 */
export function placeBeside(root: Node, target: string, edge: Edge, block: Node, containerId: string): Node | null {
  const axis: Axis = edge === "left" || edge === "right" ? "row" : "column";
  const split = splitPane(root, target, axis, withoutField(block, "size"), containerId);
  if (split === null) return null;
  return edge === "left" || edge === "top" ? swapPanes(split, idOf(block), target) : split;
}

/**
 * The tree with pane `source` moved beside pane `target` on `edge` of it, herdr-app's `move_pane` with an edge: the
 * source leaves (its share to the neighbour it was split from), then splits the target's place along the edge's axis,
 * before the target for left and top. Both stay the same panes, so their terminals never restart. Null when either is
 * not a pane of this tree or they are one pane.
 */
export function movePane(root: Node, source: string, target: string, edge: Edge, containerId: string): Node | null {
  if (source === target) return null;
  const path = pathTo(root, source);
  const moving = path === null ? null : nodeAt(root, path);
  const targetPath = pathTo(root, target);
  const targetNode = targetPath === null ? null : nodeAt(root, targetPath);
  if (moving === null || isContainer(moving) || targetNode === null || isContainer(targetNode)) return null;
  const without = removePane(root, source);
  return without === null ? null : placeBeside(without, target, edge, moving, containerId);
}

const halved = (node: Node, share: number): Node =>
  weightOf(node) === null ? node : withField(node, "size", { weight: share / 2 });

/**
 * Puts `block` after `target` along `axis`, herdr-app's `Node::split`: a parent that already runs along `axis` takes
 * it as a sibling and the two halve the target's share; otherwise the target is wrapped in a new container that keeps
 * the target's slot size. Null when the target is not a pane of this tree.
 */
export function splitPane(root: Node, target: string, axis: Axis, block: Node, containerId: string): Node | null {
  const path = pathTo(root, target);
  const at = path?.at(-1);
  if (path === null || at === undefined) return null;
  const parentPath = path.slice(0, -1);
  const parent = nodeAt(root, parentPath);
  const old = nodeAt(root, path);
  if (parent === null || old === null || isContainer(old)) return null;
  if (typeOf(parent) === axis) {
    const share = weightOf(old) ?? 1;
    return replaceAt(root, parentPath, (node) => {
      const children = childrenOf(node);
      const next = [...children.slice(0, at), halved(old, share), halved(block, share), ...children.slice(at + 1)];
      return { ...node, children: next };
    });
  }
  const slot = old["size"];
  const wrapper: Node = {
    children: [withoutField(old, "size"), block],
    id: containerId,
    ...(slot === undefined ? {} : { size: slot }),
    type: axis,
  };
  return replaceAt(root, path, () => wrapper);
}
