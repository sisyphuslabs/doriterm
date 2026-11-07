import type { View } from "@doriface/mesh";

/**
 * Every key `root` admitted, transitively, in member order: the view's admitter map (design 6.1), which names one
 * admitter per member, the signer of its governing admission.
 */
export function subtreeOf(view: View, root: string): readonly string[] {
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const key of view.members) {
      const admitter = view.admitter.get(key);
      if (tree.has(key) || admitter === undefined || !tree.has(admitter)) continue;
      tree.add(key);
      grew = true;
    }
  }
  return [...view.members].filter((key) => key !== root && tree.has(key));
}
